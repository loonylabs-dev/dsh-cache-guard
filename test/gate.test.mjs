/**
 * Unit tests for the gate: pricing, the question, and the decision.
 *
 *   node test/gate.test.mjs
 *
 * The fixtures stand in for the harness: a priced surface, a request/context
 * event, a pruner, a meter, and a question provider that records what it was
 * asked. The engine is a plain object with the one method the gate wraps.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decide, installGate, OPTIONS, describe as describePlan, routedTarget } from '../lib/gate.js'
import { createPolicyStore } from '../lib/policy.js'

/** Ten 80k nodes plus a prunable 60k tool result at seq 0, priced the way the meter would. */
function fixture() {
  const prices = [60_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000]
  const nodes = prices.map((tokens, seq) => ({ seq, tokens }))
  const surfaceTokens = prices.reduce((total, tokens) => total + tokens, 0)
  // Indexed by seq, as the log is: the prunable result sits at seq 0 and carries 60k of text.
  const events = []
  events[0] = {
    type: 'tool/result',
    seq: 0,
    data: { message: { role: 'tool', content: [{ type: 'text', content: [{ type: 'text', text: 'x'.repeat(60_000) }] }] } },
  }
  events[1] = { type: 'turn/start', seq: 1, data: { turn: 7 } }
  events[2] = { type: 'request/context', seq: 2, data: { provider: 'p', model: 'm', contextWindow: 1_000_000 } }
  const session = {
    id: 'session-1',
    events,
    surface: { nodes: nodes.map(node => node.seq) },
  }
  const asked = []
  const provider = {
    ask: async request => {
      asked.push(request)
      return { answers: [{ id: 'cache-guard', selected: [request.answer ?? OPTIONS.decline] }] }
    },
  }
  const ctx = {
    get: service => service === 'userQuestions' ? provider : (service === 'toolResultPruner' ? pruner : undefined),
    tokenMeter: {
      measure: () => ({ nodes, surfaceTokens, totalTokens: surfaceTokens + 40_000 }),
      estimateMessage: message => message.content[0].content.map(block => block.text ?? '').join('').length,
    },
  }
  const pruner = {
    pruneContent: blocks => blocks[0].text.length > 1000 ? [{ type: 'text', text: blocks[0].text.slice(0, 100) }] : null,
  }
  return { session, ctx, provider, asked, nodes }
}

const ENGINE = { config: { thresholdRatio: 0.9, retainRatio: 0.2, modelPolicies: [] } }
const CONFIG = { mode: 'manual', estimatedSummaryTokens: 4_000 }
const silent = { info: () => {}, warn: () => {} }

describe('routedTarget', () => {
  it('reads the newest request/context event', () => {
    const { session } = fixture()
    assert.deepEqual(routedTarget(session), { provider: 'p', model: 'm', contextWindow: 1_000_000 })
  })
})

describe('describePlan', () => {
  it('reports the cold re-read and its share of the request', async () => {
    const { ctx, session } = fixture()
    const policy = createPolicyStore({ defaultMode: 'manual' })
    await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    const text = describePlan(policy.lastAction('session-1'), { pricePerMTokens: 0.14 })
    assert.match(text, /Context: 900k of 1\.00M/)
    assert.match(text, /Prunes 1 old tool results: 60k freed/)
    assert.match(text, /800k re-read in full \(95% of the request\)/)
    assert.match(text, /≈ \$0\.1120/)
  })
})

describe('decide', () => {
  it('asks in manual mode and allows the change when it is accepted', async () => {
    const { ctx, session, provider, asked } = fixture()
    provider.ask = async request => {
      asked.push(request)
      return { answers: [{ id: 'cache-guard', selected: [OPTIONS.allow] }] }
    }
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'allowed')
    assert.equal(asked.length, 1)
    assert.equal(asked[0].questions[0].options.length, 3)
  })

  it('declines the change and remembers the turn', async () => {
    const { ctx, session, asked } = fixture()
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const first = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    const second = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(first, 'declined')
    assert.equal(second, 'declined')
    assert.equal(asked.length, 1, 'a declined turn must not be re-asked every step')
  })

  it('does not ask in auto mode', async () => {
    const { ctx, session, asked } = fixture()
    const policy = createPolicyStore({ defaultMode: 'auto' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'allowed')
    assert.equal(asked.length, 0)
    assert.equal(policy.lastAction('session-1').kind, 'prune-only')
  })

  it('switches the session to auto when the answer says so', async () => {
    const { ctx, session, provider } = fixture()
    provider.ask = async request => ({ answers: [{ id: 'cache-guard', selected: [OPTIONS.auto] }] })
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'allowed')
    assert.equal(policy.mode('session-1'), 'auto')
  })

  it('fails closed when no question provider is registered', async () => {
    const { ctx, session } = fixture()
    ctx.get = () => undefined
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'declined')
  })

  it('lets a below-threshold step run without a question', async () => {
    const { ctx, session, asked } = fixture()
    ctx.tokenMeter.measure = () => ({ nodes: [{ seq: 0, tokens: 1000 }], surfaceTokens: 1000, totalTokens: 41_000 })
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'allowed')
    assert.equal(asked.length, 0)
  })
})

describe('installGate', () => {
  it('declines by returning null and restores the engine on dispose', async () => {
    const { ctx, session } = fixture()
    let ran = 0
    const engine = {
      config: ENGINE.config,
      compactIfNeeded: async () => {
        ran += 1
        return { compactionId: 'x' }
      },
    }
    const original = engine.compactIfNeeded
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const dispose = installGate({ ctx, engine, policy, config: CONFIG, logger: silent })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.equal(result, null)
    assert.equal(ran, 0)
    dispose()
    assert.equal(engine.compactIfNeeded, original)
  })

  it('runs the engine when the plan is accepted', async () => {
    const { ctx, session, provider } = fixture()
    provider.ask = async request => ({ answers: [{ id: 'cache-guard', selected: [OPTIONS.allow] }] })
    let ran = 0
    const engine = {
      config: ENGINE.config,
      compactIfNeeded: async () => {
        ran += 1
        return { compactionId: 'x' }
      },
    }
    const policy = createPolicyStore({ defaultMode: 'manual' })
    installGate({ ctx, engine, policy, config: CONFIG, logger: silent })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.deepEqual(result, { compactionId: 'x' })
    assert.equal(ran, 1)
  })
})
