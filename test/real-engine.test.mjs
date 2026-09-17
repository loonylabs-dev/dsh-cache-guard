/**
 * Real-composition test: the shipped compaction engine, the shipped token meter,
 * the shipped pruner, and the guard, driven through the engine's own automatic
 * path (`agent/pre-step`).
 *
 *   node test/real-engine.test.mjs
 *
 * Only the LLM adapter and the question provider are fakes — the two external
 * services a unit test may stand in for. Everything the guard intercepts is the
 * real thing, so this is what proves the dialog is reachable at all.
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
import { installGate, OPTIONS } from '../lib/gate.js'
import { createPolicyStore } from '../lib/policy.js'

const WINDOW = 20_000

/** A real session whose surface sits above the configured pressure threshold. */
function buildSession(messages = 12, textChars = 2_000) {
  const events = []
  const push = (type, data, extra = {}) => {
    events.push({ type, seq: events.length, time: 1_000 + events.length, data, ...extra })
  }
  push('turn/start', { turn: 1 })
  // The engine resolves its target from the durable request header, not from
  // `request/context`; both are needed to reproduce a real session.
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
  return Session.create(SessionId('cache-guard-real'), events)
}

/** Mount the real composition and wrap its engine with the guard. */
async function harness({ mode = 'manual', answer = null, gate: withGate = true } = {}) {
  const ctx = new Context()
  const asked = []
  const streamOptions = []
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
      return { answers: [{ id: 'cache-guard', selected: [answer] }] }
    },
  })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ToolResultPruner)
  await ctx.plugin(BasicCompactionEngine, { thresholdRatio: 0.5, retainRatio: 0.1, auto: true })

  const session = buildSession()
  const agent = { session, options: { provider: 'p', model: 'm' } }
  const policy = createPolicyStore({ defaultMode: mode })
  const dispose = withGate
    ? installGate({
      ctx,
      engine: ctx.compaction,
      policy,
      config: { mode, estimatedSummaryTokens: 1_000 },
      logger: { info: () => {}, warn: () => {} },
    })
    : () => {}

  return { ctx, session, agent, policy, asked, streamOptions, dispose }
}

/** Drive the engine's own automatic path, exactly as the agent loop does. */
function preStep(ctx, agent) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
}

const kinds = session => session.events.filter(event => event.type.startsWith('compaction/')).map(event => event.type)

describe('guard over the real engine', () => {
  it('asks through the real question service before the engine rewrites anything', async () => {
    const { ctx, agent, asked, dispose } = await harness({ answer: OPTIONS.allow })
    await preStep(ctx, agent)
    assert.equal(asked.length, 1, 'the engine path must reach the question provider')
    const question = asked[0].questions[0]
    assert.equal(question.options.length, 3)
    assert.match(question.detail, /rewrite at/)
    assert.match(question.detail, /re-read in full/)
    dispose()
  })

  it('declining leaves the surface untouched and continues the step', async () => {
    const { ctx, agent, session, streamOptions, dispose } = await harness({ answer: OPTIONS.decline })
    const decision = await preStep(ctx, agent)
    assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'the step must continue normally')
    assert.deepEqual(kinds(session), [], 'no compaction event may land')
    assert.equal(streamOptions.length, 0, 'no summarization call may run')
    dispose()
  })

  it('accepting lets the real engine compact, cache cost and all', async () => {
    const { ctx, agent, session, streamOptions, dispose } = await harness({ answer: OPTIONS.allow })
    await preStep(ctx, agent)
    assert.equal(streamOptions.length, 1, 'the real engine summarizes on accept')
    assert.equal(streamOptions[0].purpose, 'compaction')
    assert.deepEqual(kinds(session), ['compaction/start', 'compaction/summary', 'compaction/end'])
    dispose()
  })

  it('auto mode never asks and still compacts', async () => {
    const { ctx, agent, session, asked, streamOptions, dispose } = await harness({ mode: 'auto' })
    await preStep(ctx, agent)
    assert.equal(asked.length, 0, 'auto mode must not prompt')
    assert.equal(streamOptions.length, 1)
    assert.deepEqual(kinds(session), ['compaction/start', 'compaction/summary', 'compaction/end'])
    dispose()
  })

  it('records the live pressure and the last action for the client surface', async () => {
    const { ctx, agent, policy, dispose } = await harness({ answer: OPTIONS.decline })
    await preStep(ctx, agent)
    const pressure = policy.pressure('cache-guard-real')
    assert.equal(pressure.contextWindow, WINDOW)
    assert.ok(pressure.totalTokens > 0)
    assert.equal(pressure.thresholdTokens, WINDOW / 2)
    const action = policy.lastAction('cache-guard-real')
    assert.equal(action.kind, 'prune-and-summarize')
    assert.equal(action.outcome, 'declined')
    assert.ok(action.estimate.coldTokens > 0)
    dispose()
  })

  it('is a no-op without the guard: the engine compacts on its own', async () => {
    const { ctx, agent, session, asked, dispose } = await harness({ gate: false })
    await preStep(ctx, agent)
    assert.equal(asked.length, 0)
    assert.deepEqual(kinds(session), ['compaction/start', 'compaction/summary', 'compaction/end'])
    dispose()
  })

  it('restores the engine method when it unloads', async () => {
    const { ctx, agent, dispose } = await harness({ answer: OPTIONS.decline })
    const wrapped = ctx.compaction.compactIfNeeded
    dispose()
    assert.notEqual(ctx.compaction.compactIfNeeded, wrapped)
  })
})
