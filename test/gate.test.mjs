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

/**
 * A priced surface shaped like a real one: `extraNodes` 80k conversation nodes,
 * then a tool call with its oversized 60k result as the NEWEST pair, plus a 40k
 * request envelope. A tool result only follows an assistant tool call, so the
 * surface has to carry both — the guard's safe-cut rule reads exactly that.
 */
function fixture({ extraNodes = 6 } = {}) {
  const callSeq = 10 + extraNodes
  const resultSeq = callSeq + 1
  const prices = [
    ...Array.from({ length: callSeq }, () => 80_000),
    1_000, // the assistant tool call itself
    60_000, // its result: the prunable node
  ]
  const nodes = prices.map((tokens, seq) => ({ seq, tokens }))
  const surfaceTokens = prices.reduce((total, tokens) => total + tokens, 0)
  // Indexed by seq, as the log is.
  const events = []
  events[callSeq] = {
    type: 'assistant/message',
    seq: callSeq,
    data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }] } },
  }
  events[resultSeq] = {
    type: 'tool/result',
    seq: resultSeq,
    data: { message: { role: 'tool', content: [{ type: 'text', content: [{ type: 'text', text: 'x'.repeat(60_000) }] }] } },
  }
  events[resultSeq + 1] = { type: 'turn/start', seq: resultSeq + 1, data: { turn: 7 } }
  events[resultSeq + 2] = {
    type: 'request/context',
    seq: resultSeq + 2,
    data: { provider: 'p', model: 'm', contextWindow: 1_000_000 },
  }
  const session = {
    id: 'session-1',
    events,
    surface: { nodes: nodes.map(node => node.seq) },
  }
  const asked = []
  const compactionCalls = []
  const pruneCalls = []
  const provider = {
    ask: async request => {
      asked.push(request)
      return { answers: [{ id: 'cache-guard', selected: [request.answer ?? OPTIONS.decline] }] }
    },
  }
  const pruner = {
    pruneContent: blocks => blocks[0].text.length > 1000 ? [{ type: 'text', text: blocks[0].text.slice(0, 100) }] : null,
    pruneSession: session_ => {
      pruneCalls.push(session_)
      return { pruned: [{ originalSeq: resultSeq }], charsRemoved: 59_900 }
    },
  }
  const compaction = {
    compactRegion: async (start, end) => {
      compactionCalls.push({ start, end })
      return { compactionId: 'compact-1' }
    },
  }
  const meter = {
    measure: () => ({ nodes, surfaceTokens, totalTokens: surfaceTokens + 40_000 }),
    estimateMessage: message => message.content[0].content.map(block => block.text ?? '').join('').length,
  }
  const ctx = {
    get: service => {
      if (service === 'userQuestions') return provider
      if (service === 'toolResultPruner') return pruner
      if (service === 'compaction') return compaction
      if (service === 'tokenMeter') return meter
      return undefined
    },
    tokenMeter: meter,
  }
  return { session, ctx, provider, asked, nodes, compactionCalls, pruneCalls, callSeq, resultSeq, meter }
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
  it('reports both phases, the cold re-read, and its share of the request', async () => {
    const { ctx, session } = fixture()
    const policy = createPolicyStore({ defaultMode: 'manual' })
    await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    const text = describePlan(policy.lastAction('session-1'), { pricePerMTokens: 0.14 })
    assert.match(text, /Context: [\d.]+M of 1\.00M \(rewrite at 900k\)/)
    assert.match(text, /Prunes 1 old tool results: 60k freed/)
    assert.match(text, /Then summarizes/)
    assert.match(text, /re-read in full \(\d+% of the request\)/)
    assert.match(text, /≈ \$/)
  })
})

describe('the pruning rule', () => {
  it('declines without asking when no range can be summarized', async () => {
    // A retention budget the whole surface fits into leaves nothing to replace —
    // the stand-in for any surface whose tail is indivisible. The guard never
    // prunes on its own, so there is no decision to offer.
    const { ctx, session, asked } = fixture()
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const everythingRetained = { config: { thresholdRatio: 0.9, retainRatio: 2, modelPolicies: [] } }
    const decision = await decide({ ctx, engine: everythingRetained, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'declined')
    assert.equal(asked.length, 0)
    assert.equal(policy.lastAction('session-1'), undefined)
  })

  it('puts the whole operation to the human, pruning included', async () => {
    const { ctx, session, asked } = fixture()
    const policy = createPolicyStore({ defaultMode: 'manual' })
    await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(asked.length, 1)
    const action = policy.lastAction('session-1')
    assert.equal(action.kind, 'prune-and-summarize')
    assert.ok(action.summary !== null, 'the priced plan carries the span the guard will replace')
    assert.ok(action.pruned.length > 0, 'and the pruning it runs behind the checkpoint')
  })

  it('never runs the engine\'s own method — it owns the operation', async () => {
    const { ctx, session, compactionCalls, pruneCalls } = fixture()
    let ran = 0
    const engine = {
      config: ENGINE.config,
      compactIfNeeded: async () => {
        ran += 1
        return { compactionId: 'engine-own' }
      },
    }
    const policy = createPolicyStore({ defaultMode: 'auto' })
    installGate({ ctx, engine, policy, config: CONFIG, logger: silent })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.equal(ran, 0, 'the original method must never run')
    assert.equal(result.compactionId, 'compact-1', 'the result comes from the guard\'s own transaction')
    assert.equal(compactionCalls.length, 1)
    assert.equal(pruneCalls.length, 1, 'pruning runs too, in the same operation')
  })

  it('compacts BEFORE it prunes, so one cache break covers both', async () => {
    const { ctx, session } = fixture()
    const order = []
    ctx.get = service => {
      if (service === 'toolResultPruner') {
        return { pruneContent: () => null, pruneSession: () => { order.push('prune'); return { pruned: [] } } }
      }
      if (service === 'compaction') {
        return { compactRegion: async () => { order.push('compact'); return { compactionId: 'c' } } }
      }
      if (service === 'tokenMeter') return ctx.tokenMeter
      return undefined
    }
    const engine = { config: ENGINE.config, compactIfNeeded: async () => null }
    installGate({ ctx, engine, policy: createPolicyStore({ defaultMode: 'auto' }), config: CONFIG, logger: silent })
    await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.deepEqual(order, ['compact', 'prune'])
  })

  it('leaves the surface untouched when the answer is no', async () => {
    const { ctx, session, compactionCalls, pruneCalls, asked } = fixture()
    const engine = { config: ENGINE.config, compactIfNeeded: async () => ({ compactionId: 'nope' }) }
    installGate({ ctx, engine, policy: createPolicyStore({ defaultMode: 'manual' }), config: CONFIG, logger: silent })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.equal(asked.length, 1)
    assert.equal(result, null)
    assert.equal(compactionCalls.length, 0)
    assert.equal(pruneCalls.length, 0)
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
    assert.equal(policy.lastAction('session-1').kind, 'prune-and-summarize')
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
    const inner = ctx.get
    ctx.get = service => (service === 'userQuestions' ? undefined : inner(service))
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    assert.equal(decision, 'declined')
  })

  it('does nothing below the threshold, without asking', async () => {
    const { ctx, session, asked, meter } = fixture()
    meter.measure = () => ({ nodes: [{ seq: 0, tokens: 1000 }], surfaceTokens: 1000, totalTokens: 41_000 })
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const decision = await decide({ ctx, engine: ENGINE, policy, agent: {}, session, sessionId: 'session-1', trigger: 'pressure', config: CONFIG, logger: silent })
    // `declined` is the wrapper's "do nothing" — the same answer as a human's no.
    assert.equal(decision, 'declined')
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

  it('runs its own combined operation when the plan is accepted, never the engine\'s', async () => {
    const { ctx, session, provider, compactionCalls, pruneCalls } = fixture()
    provider.ask = async request => ({ answers: [{ id: 'cache-guard', selected: [OPTIONS.allow] }] })
    let ran = 0
    const engine = {
      config: ENGINE.config,
      compactIfNeeded: async () => {
        ran += 1
        return { compactionId: 'engine-own' }
      },
    }
    const policy = createPolicyStore({ defaultMode: 'manual' })
    installGate({ ctx, engine, policy, config: CONFIG, logger: silent })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.deepEqual(result, { compactionId: 'compact-1' })
    assert.equal(ran, 0, 'the engine\'s own two-phase path must not run at all')
    assert.equal(compactionCalls.length, 1)
    assert.equal(pruneCalls.length, 1)
  })

  it('leaves the operation to the engine in off mode', async () => {
    const { ctx, session, asked, compactionCalls } = fixture()
    let ran = 0
    const engine = {
      config: ENGINE.config,
      compactIfNeeded: async () => {
        ran += 1
        return { compactionId: 'engine-own' }
      },
    }
    installGate({
      ctx,
      engine,
      policy: createPolicyStore({ defaultMode: 'off' }),
      config: { ...CONFIG, mode: 'off' },
      logger: silent,
    })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.deepEqual(result, { compactionId: 'engine-own' }, 'off hands the decision back to the engine')
    assert.equal(ran, 1)
    assert.equal(asked.length, 0, 'off asks nobody')
    assert.equal(compactionCalls.length, 0, 'off prices nothing')
  })

  it('hands a pricing failure back to the engine instead of blocking it', async () => {
    // A guard bug may cost money; it may never strand a session by declining an
    // operation it could not price.
    const { session } = fixture()
    let ran = 0
    const engine = {
      config: ENGINE.config,
      compactIfNeeded: async () => {
        ran += 1
        return { compactionId: 'engine-own' }
      },
    }
    const warnings = []
    installGate({
      ctx: { get: () => { throw new Error('no meter here') } },
      engine,
      policy: createPolicyStore({ defaultMode: 'manual' }),
      config: CONFIG,
      logger: { info: () => {}, warn: message => warnings.push(message) },
    })
    const result = await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.deepEqual(result, { compactionId: 'engine-own' })
    assert.equal(ran, 1)
    assert.match(warnings[0], /pricing failed/)
    assert.match(warnings[0], /the engine decides this one itself/)
  })

  it('wraps an engine once, whoever gets there first', async () => {
    const { ctx, session, asked } = fixture()
    const engine = { config: ENGINE.config, compactIfNeeded: async () => ({ compactionId: 'own' }) }
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const messages = []
    installGate({ ctx, engine, policy, config: CONFIG, logger: silent, owner: 'host plane' })
    const wrapped = engine.compactIfNeeded
    installGate({
      ctx,
      engine,
      policy,
      config: CONFIG,
      logger: { info: message => messages.push(message), warn: () => {} },
      owner: 'preset row',
    })
    assert.equal(engine.compactIfNeeded, wrapped, 'the second installer must leave the wrapper alone')
    assert.match(messages[0], /already guarded by the host plane/)
    assert.equal(policy.engines(), 1, 'and it must not count as a second guarded engine')
    await engine.compactIfNeeded({ session }, 'pressure', new AbortController().signal)
    assert.equal(asked.length, 1, 'one wrapper, one question')
  })

  it('reports how many engines it guards, and takes the count back on dispose', () => {
    const { ctx } = fixture()
    const policy = createPolicyStore({ defaultMode: 'manual' })
    const first = { config: ENGINE.config, compactIfNeeded: async () => null }
    const second = { config: ENGINE.config, compactIfNeeded: async () => null }
    const disposeFirst = installGate({ ctx, engine: first, policy, config: CONFIG, logger: silent })
    const disposeSecond = installGate({ ctx, engine: second, policy, config: CONFIG, logger: silent })
    assert.equal(policy.engines(), 2)
    disposeFirst()
    assert.equal(policy.engines(), 1)
    disposeSecond()
    assert.equal(policy.engines(), 0)
  })
})
