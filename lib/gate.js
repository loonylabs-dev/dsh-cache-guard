/**
 * The gate in front of the automatic context operations.
 *
 * `compaction-basic` registers its automatic listeners with `this` bound to the
 * engine instance, so replacing the instance method intercepts both the
 * step-pressure path and the provider-overflow recovery path — the two places
 * that rewrite the model-visible surface. Nothing is imported from the engine:
 * the gate prices the plan through the public services it is handed and either
 * lets the original method run or declines by returning `null`.
 *
 * @module dsh-cache-guard/gate
 */
import { formatTokens, costOf } from './cold-cost.js'
import { planChange } from './plan.js'

/** Option labels; the answer is matched on these exact strings. */
export const OPTIONS = {
  allow: 'Allow once',
  decline: 'Not now',
  auto: 'Always allow (this session)',
}

/**
 * The routed provider/model and its context window.
 *
 * The engine resolves its target from the durable `request/header` (see
 * `routedTarget` in `@deepseek-ai/dsh-compaction-basic`), so the guard reads the
 * same source and would price a different model than the engine otherwise. The
 * window is not part of the header; it comes from the newest `request/context`.
 *
 * @param session - session whose routing is read.
 * @returns `{ provider, model, contextWindow }`, each possibly undefined.
 */
export function routedTarget(session) {
  let header
  try {
    header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  } catch {
    header = undefined
  }
  const config = header?.config
  const events = session.events ?? []
  let context
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/context') {
      context = event.data ?? {}
      break
    }
  }
  return {
    provider: config?.provider ?? context?.provider,
    model: config?.model ?? context?.model,
    contextWindow: context?.contextWindow,
  }
}

/** Turn number of the session's newest `turn/start`, or 0 before the first turn. */
export function currentTurn(session) {
  const events = session.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') return event.data?.turn ?? 0
  }
  return 0
}

/** Surface tool results in model-visible order, mirroring the pruner's own walk. */
export function surfaceToolResults(session) {
  const events = session.events ?? []
  const nodes = session.surface?.nodes ?? []
  const found = []
  for (const seq of [...nodes]) {
    const event = events[seq]
    if (event?.type === 'tool/result') found.push({ seq, message: event.data?.message })
  }
  return found
}

/** Requests below this size are not real turns; they are not used as a fixed-part anchor. */
const MIN_REQUEST_TOKENS = 1_000

/**
 * The session's fixed request part: system prompt, tools, and the opening message.
 *
 * It is read from the provider's own reported usage rather than from the meter's
 * residual, which on a provider-anchored session mixes the anchor with a
 * heuristic surface and overstated the fixed part about sevenfold when measured.
 * A larger opening message makes the estimate slightly high and the cold read
 * slightly low.
 *
 * @param session - session whose logged requests are scanned.
 * @returns the cheapest real request total, or `undefined` before any request.
 */
export function sessionEnvelopeTokens(session) {
  const events = session.events ?? []
  let smallest
  for (const event of events) {
    const usage = event?.type === 'assistant/message' ? event.data?.usage : undefined
    if (usage === undefined) continue
    const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    if (total < MIN_REQUEST_TOKENS) continue
    if (smallest === undefined || total < smallest) smallest = total
  }
  return smallest
}

/** Read the engine's resolution inputs into the plan module's shape. */
export function planInputs({ ctx, engine, session, trigger, estimatedSummaryTokens }) {
  const pruner = ctx.get('toolResultPruner')
  const { provider, model, contextWindow } = routedTarget(session)
  return {
    measurement: ctx.tokenMeter.measure(session),
    envelopeTokens: sessionEnvelopeTokens(session),
    contextWindow,
    config: engine.config,
    provider,
    model,
    trigger,
    toolResults: surfaceToolResults(session),
    pruneContent: pruner === undefined ? () => null : blocks => pruner.pruneContent(blocks),
    estimateMessage: message => ctx.tokenMeter.estimateMessage(message),
    estimatedSummaryTokens,
  }
}

/** Human-readable dialog copy for one priced plan. */
export function describe(plan, prices) {
  const lines = []
  const share = plan.estimate === null || plan.estimate.totalTokens === 0
    ? undefined
    : Math.round(plan.estimate.coldTokens / plan.estimate.totalTokens * 100)
  if (plan.contextWindow !== undefined) {
    lines.push(`Context: ${formatTokens(plan.totalTokens)} of ${formatTokens(plan.contextWindow)} `
      + `(rewrite at ${formatTokens(plan.thresholdTokens)})`)
  }
  if (plan.kind === 'context-overflow') lines.push('The provider window overflowed.')
  if (plan.pruned.length > 0) {
    lines.push(`Prunes ${plan.pruned.length} old tool results: ${formatTokens(plan.freedByPrune)} freed`)
  }
  if (plan.summary !== null && plan.summary !== undefined) {
    lines.push(`Then summarizes: ~${formatTokens(plan.summary.checkpointTokens)} checkpoint `
      + `(estimated) instead of ${formatTokens(plan.totalTokens - plan.freedByPrune)}`)
  }
  if (plan.estimate !== null && plan.estimate.coldTokens > 0) {
    const cost = costOf(plan.estimate.coldTokens, prices.pricePerMTokens)
    lines.push(`Breaks the cache at position ${plan.estimate.firstChangedPosition}: `
      + `${formatTokens(plan.estimate.coldTokens)} re-read in full`
      + (share === undefined ? '' : ` (${share}% of the request)`)
      + (cost === undefined ? '' : `, ≈ $${cost.toFixed(4)}`))
  }
  if (plan.kind === 'context-overflow') {
    lines.push('Declining ends this turn with a context error.')
  }
  return lines.join('\n')
}

/** Ask the human and map the answer to a policy action. */
async function ask(ctx, agent, plan, prices) {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) return 'unavailable'
  const answer = await questions.ask({
    agent,
    questions: [{
      id: 'cache-guard',
      header: plan.kind === 'context-overflow' ? 'Context overflow' : 'Context rewrite',
      question: plan.kind === 'context-overflow'
        ? 'The context window overflowed — summarize now?'
        : 'An automatic context rewrite is ready. Allow it?',
      detail: describe(plan, prices),
      options: [
        { label: OPTIONS.allow, description: 'Rewrite now and continue.' },
        { label: OPTIONS.decline, description: 'Change nothing; the request continues with its cache intact.' },
        { label: OPTIONS.auto, description: 'Stop asking, until this session ends.' },
      ],
    }],
  })
  const selected = answer?.answers?.find(entry => entry.id === 'cache-guard')?.selected ?? []
  if (selected.includes(OPTIONS.auto)) return 'auto'
  if (selected.includes(OPTIONS.decline)) return 'decline'
  if (selected.includes(OPTIONS.allow)) return 'allow'
  return 'unavailable'
}

/**
 * Decide one pending operation, record what was priced, and report the answer.
 * @param input the engine, its ctx, the shared policy store, the agent, and the config.
 * @returns `'allowed'` to run the original method, `'declined'` to leave the surface untouched.
 */
export async function decide({ ctx, engine, policy, agent, session, sessionId, trigger, config, logger }) {
  const inputs = planInputs({ ctx, engine, session, trigger, estimatedSummaryTokens: config.estimatedSummaryTokens })
  const plan = planChange(inputs)
  plan.kind = trigger === 'context-overflow' ? 'context-overflow' : plan.kind
  policy.recordPressure(sessionId, {
    totalTokens: plan.totalTokens,
    contextWindow: plan.contextWindow,
    thresholdTokens: plan.thresholdTokens,
    retainTokens: plan.retainTokens,
    at: Date.now(),
  })

  // A plan that would NOT change the surface stays out of the action record, so
  // the last real intervention survives the quiet steps that follow it.
  const changing = plan.estimate !== null && plan.kind !== 'below-threshold' && plan.kind !== 'nothing'
  const outcome = decision => {
    if (changing) policy.recordAction(sessionId, { ...plan, outcome: decision })
    return decision
  }

  if (plan.estimate === null || plan.kind === 'below-threshold') return 'allowed'
  if (plan.kind === 'nothing') return trigger === 'context-overflow' ? 'allowed' : 'declined'

  const prices = { pricePerMTokens: config.pricePerMTokens }
  if (policy.mode(sessionId) === 'auto') {
    logger.info(`cache-guard (auto): ${describe(plan, prices).replace(/\n/g, ' · ')}`)
    return outcome('allowed')
  }

  const turn = currentTurn(session)
  if (policy.declinedInTurn(sessionId, turn)) {
    logger.info('cache-guard: already declined in this turn; leaving the surface untouched')
    return outcome('declined')
  }

  let answer
  try {
    answer = await ask(ctx, agent, plan, prices)
  } catch (error) {
    logger.warn(`cache-guard: question failed (${error instanceof Error ? error.message : String(error)}); declining`)
    return outcome('declined')
  }

  switch (answer) {
    case 'allow':
      return outcome('allowed')
    case 'auto':
      policy.setMode(sessionId, 'auto')
      logger.info('cache-guard: switched to auto for this session')
      return outcome('allowed')
    case 'decline':
      policy.recordDecline(sessionId, turn)
      return outcome('declined')
    default:
      logger.warn('cache-guard: no answerer is registered; declining the automatic change '
        + '(set mode: auto to let it run unrung)')
      return outcome('declined')
  }
}

/**
 * Wrap one engine instance's automatic compaction decisions.
 * @param input the engine, its ctx, the shared policy store, config, and logger.
 * @returns a disposer that restores the original method.
 */
export function installGate({ ctx, engine, policy, config, logger }) {
  const original = engine.compactIfNeeded
  engine.compactIfNeeded = async function gated(agent, trigger, signal) {
    const session = agent?.session
    if (session === undefined) return original.call(this, agent, trigger, signal)
    const sessionId = String(session.id ?? 'unknown')
    let decision
    try {
      decision = await decide({ ctx, engine: this, policy, agent, session, sessionId, trigger, config, logger })
    } catch (error) {
      logger.warn(`cache-guard: pricing failed (${error instanceof Error ? error.message : String(error)}); `
        + 'allowing the change')
      decision = 'allowed'
    }
    if (decision === 'declined') return null
    return original.call(this, agent, trigger, signal)
  }
  return () => {
    engine.compactIfNeeded = original
  }
}
