/**
 * The host plane must be able to reach the compaction engine of EVERY preset
 * realm, not only the one whose preset carries an explicit guard row.
 *
 *   node test/global-gate.test.mjs
 *
 * The realm below reproduces the shipped preset's shape: a child scope that
 * isolates `compaction` and `toolResultPruner` (what `isolate:` on a
 * `cordis:group` builds) holding the shipped engine and pruner, while
 * `tokenMeter` stays on the host plane. The probe then asks the cordis event bus
 * who can hear the service being provided in there.
 *
 * Only the LLM adapter and the question provider are fakes — the two external
 * services a test may stand in for. The engine, the meter, and the pruner are the
 * real ones.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as HostHalf from '../index.js'
import { installGate, OPTIONS } from '../lib/gate.js'
import { installGlobalGate } from '../lib/global-gate.js'
import { createPolicyStore } from '../lib/policy.js'

const WINDOW = 20_000
const SILENT = { info: () => {}, warn: () => {} }

/**
 * A real session whose surface sits above the configured pressure threshold, and
 * which carries one oversized tool result: that result is what the realm pruner
 * has to find for the plan to show the guard priced through the right context.
 */
function buildSession(messages = 12, textChars = 2_000) {
  const events = []
  const push = (type, data, extra = {}) => {
    events.push({ type, seq: events.length, time: 1_000 + events.length, data, ...extra })
  }
  push('turn/start', { turn: 1 })
  push('request/header', { header: { config: { provider: 'p', model: 'm' } } })
  push('request/context', { provider: 'p', model: 'm', contextWindow: WINDOW })
  for (let index = 0; index < messages; index += 1) {
    push('user/message', createUserMessage({
      content: [{ type: 'text', text: `user ${index} ${'u'.repeat(textChars)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    push('step/start', { turn: 1, step: index + 1 })
    push('assistant/message', {
      turn: 1,
      step: index + 1,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: `assistant ${index} ${'a'.repeat(textChars)}` }],
      }),
    }, { surfaceOp: 'append' })
    push('step/end', { turn: 1, step: index + 1 })
  }
  const step = messages + 1
  push('step/start', { turn: 1, step })
  push('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
    }),
  }, { surfaceOp: 'append' })
  push('tool/result', {
    turn: 1,
    step,
    message: {
      role: 'user',
      id: 'tool-message-1',
      source: { kind: 'tool', callId: 'call-1' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        isError: false,
        content: [{ type: 'text', text: 'x'.repeat(40_000) }],
      }],
    },
  }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step })
  return Session.create(SessionId('cache-guard-global'), events)
}

/** Drive the engine's own automatic path, exactly as the agent loop does. */
function preStep(ctx, agent) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
}

/**
 * Mount the shipped composition: host-plane fakes and meter, one isolated realm
 * carrying the engine and the pruner.
 * @param options which listener to register on the host plane, whether the
 * host-plane gate is installed before the realm appears, and the answer the
 * question provider gives.
 * @returns the host ctx, the realm, the recorded notifications, the spies, and
 * the policy store the gate reports into.
 */
async function harness({ listener, gate, answer } = {}) {
  const ctx = new Context()
  const seen = []
  const asked = []
  const streamOptions = []
  const policy = createPolicyStore({ defaultMode: gate?.mode ?? 'manual' })
  if (listener !== undefined) ctx.on('internal/service', (name, value) => seen.push({ name, value }), listener)
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }),
    stream: options => (async function* summary() {
      streamOptions.push(options)
      const text = '## Primary Request and Intent\n- condensed'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  ctx.provide('sessions', { flush: async () => {} })
  ctx.provide('userQuestions', {
    ask: async request => {
      asked.push(request)
      return { answers: [{ id: 'cache-guard', selected: answer === undefined ? [] : [answer] }] }
    },
  })
  await ctx.plugin(TokenMeter)
  // The gate has to be listening before the realm announces its engine: that
  // registration is the only announcement, and it never repeats.
  const dispose = gate === undefined
    ? () => {}
    : installGlobalGate({
      ctx,
      policy,
      config: { mode: gate.mode ?? 'manual', estimatedSummaryTokens: 1_000 },
      logger: gate.logger ?? SILENT,
    })
  const realm = ctx.isolate('compaction').isolate('toolResultPruner')
  await realm.plugin(ToolResultPruner)
  await realm.plugin(BasicCompactionEngine, { thresholdRatio: 0.5, retainRatio: 0.1, auto: true })
  const session = buildSession()
  const agent = { session, options: { provider: 'p', model: 'm' } }
  return { ctx, realm, seen, asked, streamOptions, session, agent, policy, dispose }
}

const kinds = session => session.events.filter(event => event.type.startsWith('compaction/')).map(event => event.type)

/**
 * The engine's own pass: it prunes first and summarizes only when the surface is
 * still too large. That order is the incident this plugin prices — the cache
 * break lands at the pruning rewrite, with the surface almost as large as before.
 */
const ENGINE_OWN_PASS = ['compaction/prune', 'compaction/start', 'compaction/summary', 'compaction/end']

/** The guard's pass: one checkpoint first, so the pruning rides behind that break. */
const GUARDED_PASS = ['compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune']

describe('reaching a preset realm from the host plane', () => {
  it('a scope-filtered listener does NOT hear the realm engine', async () => {
    const { ctx, realm, seen } = await harness({ listener: undefined })
    assert.equal(seen.length, 0, 'nothing was listened for in this arm')
    // Where the engine lives, on both planes: the realm holds it, the host does not.
    assert.equal(realm.get('compaction')?.name, 'compaction')
    assert.equal(ctx.get('compaction'), undefined, 'the host plane has no engine of its own')
  })

  it('a { global: true } listener DOES hear the realm engine', async () => {
    const { realm, seen } = await harness({ listener: { global: true } })
    const engines = seen.filter(entry => entry.name === 'compaction')
    assert.equal(engines.length, 1, `expected exactly one compaction registration, saw ${seen.length} services`)
    // The announced value is the instance the agent's listeners call: a traced
    // read of the service is a different object, which is why the gate wraps the
    // announced one and marks the wrapper FUNCTION rather than the instance.
    assert.equal(typeof engines[0].value.compactIfNeeded, 'function', 'the instance is what a gate has to wrap')
    assert.equal(typeof realm.get('compaction').compactIfNeeded, 'function', 'and the realm resolves that same engine')
  })

  it('without { global: true } the realm engine stays invisible', async () => {
    const { seen } = await harness({ listener: {} })
    assert.equal(seen.filter(entry => entry.name === 'compaction').length, 0,
      'the scope filter is exactly why an engine row inside the preset was needed')
  })

  it('the realm engine compacts on its own while nothing wraps it', async () => {
    const { ctx, agent, session, asked } = await harness({ listener: { global: true } })
    await preStep(ctx, agent)
    assert.equal(asked.length, 0, 'the engine asks nobody')
    assert.deepEqual(kinds(session), ENGINE_OWN_PASS,
      'this is the incident: the unguarded engine prunes the surface by itself, unasked')
  })
})

describe('the host-plane gate over a preset realm', () => {
  it('wraps the engine of a realm it never composes itself', async () => {
    const { ctx, agent, session, policy, dispose } = await harness({ gate: {} })
    assert.equal(policy.engines(), 1, 'the host plane must count the engine it guards')
    await preStep(ctx, agent)
    assert.equal(policy.engines(), 1, 'and a step must not add a second one')
    dispose()
    // Unwrapped again: the engine is back in charge of its own decisions.
    assert.equal(policy.engines(), 0)
    await preStep(ctx, agent)
    assert.deepEqual(kinds(session), ENGINE_OWN_PASS)
  })

  it('asks before the realm engine rewrites anything', async () => {
    const { ctx, agent, session, asked, streamOptions, dispose } = await harness({ gate: {} })
    await preStep(ctx, agent)
    assert.equal(asked.length, 1, 'the dialog must be reached from the host plane')
    assert.match(asked[0].questions[0].detail, /re-read in full/)
    assert.deepEqual(kinds(session), [], 'a decline leaves the surface alone')
    assert.equal(streamOptions.length, 0)
    dispose()
  })

  it('prices through the realm, not through the host plane', async () => {
    // The pruner exists only inside the realm. A gate that priced through the
    // host ctx would plan no pruning at all and understate the cold re-read.
    const { ctx, agent, policy, dispose } = await harness({ gate: {} })
    await preStep(ctx, agent)
    const action = policy.lastAction('cache-guard-global')
    assert.ok(action.pruned.length > 0, 'the plan must carry the realm pruner\'s verdict')
    assert.ok(action.freedByPrune > 0, 'and the budget the realm pruner resolved')
    assert.equal(action.outcome, 'declined')
    assert.ok(action.estimate.coldTokens > 0)
    dispose()
  })

  it('runs the realm engine\'s own operation when the plan is accepted', async () => {
    const { ctx, agent, session, streamOptions, dispose } = await harness({ gate: {}, answer: OPTIONS.allow })
    await preStep(ctx, agent)
    assert.equal(streamOptions.length, 1)
    assert.deepEqual(kinds(session), GUARDED_PASS,
      'the guard lands the checkpoint first, so the pruning adds no second cache break')
    dispose()
  })

  it('leaves the realm engine alone in off mode', async () => {
    const { ctx, agent, session, asked, policy, dispose } = await harness({ gate: { mode: 'off' } })
    await preStep(ctx, agent)
    assert.equal(asked.length, 0, 'off asks nobody')
    assert.deepEqual(kinds(session), ENGINE_OWN_PASS, 'off hands the decision back to the engine')
    assert.equal(policy.pressure('cache-guard-global'), undefined, 'off prices nothing')
    dispose()
  })

  it('does not wrap a realm engine the preset row already guarded', async () => {
    const { ctx, realm, agent, policy } = await harness({})
    // What a preset's engine row does, arriving after the host plane did not.
    installGate({
      ctx: realm,
      engine: realm.get('compaction'),
      policy,
      config: { mode: 'manual', estimatedSummaryTokens: 1_000 },
      logger: SILENT,
    })
    assert.equal(policy.engines(), 1)
    const messages = []
    const dispose = installGlobalGate({
      ctx,
      policy,
      config: { mode: 'manual', estimatedSummaryTokens: 1_000 },
      logger: { info: message => messages.push(message), warn: () => {} },
    })
    await preStep(ctx, agent)
    assert.equal(policy.engines(), 1, 'a second gate must not count the same engine twice')
    dispose()
  })

  it('arms the gate from the shipped host half, with a preset that carries no row', async () => {
    // The end of the claim: mounting the plugin's own host half is what guards a
    // session, without touching any preset.
    const ctx = new Context()
    const asked = []
    ctx.provide('llm', { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }) })
    ctx.provide('sessions', { flush: async () => {} })
    ctx.provide('userQuestions', {
      ask: async request => { asked.push(request); return { answers: [{ id: 'cache-guard', selected: [] }] } },
    })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(HostHalf)
    assert.equal(ctx.cacheGuard.engines(), 0, 'nothing is guarded before a realm exists')

    const realm = ctx.isolate('compaction').isolate('toolResultPruner')
    await realm.plugin(ToolResultPruner)
    await realm.plugin(BasicCompactionEngine, { thresholdRatio: 0.5, retainRatio: 0.1, auto: true })
    assert.equal(ctx.cacheGuard.engines(), 1, 'the host half must have wrapped the realm engine')

    const session = buildSession()
    await preStep(ctx, { session, options: { provider: 'p', model: 'm' } })
    assert.equal(asked.length, 1, 'and the session is asked before anything is rewritten')
    assert.deepEqual(kinds(session), [])
  })
})
