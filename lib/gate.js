/**
 * The gate in front of the automatic context operations.
 *
 * `compaction-basic` registers its automatic listeners with `this` bound to the
 * engine instance, so replacing the instance method intercepts both the
 * step-pressure path and the provider-overflow recovery path — the two places
 * that rewrite the model-visible surface.
 *
 * The gate OWNS the operation rather than steering the engine's own one: it never
 * calls the original method. An accepted plan runs the engine's public
 * `compactRegion` transaction and then the pruner, so pruning never lands alone
 * and the provider's cache is broken once per event instead of once per phase.
 * Everything the harness owns around it — the transaction, the lifecycle, the
 * retry accounting in the calling listeners — stays the harness's.
 *
 * @module dsh-cache-guard/gate
 */
import { formatTokens, costOf, splitMeasurement } from './cold-cost.js'
import { balancedCuts, planChange } from './plan.js'

/** Option labels; the answer is matched on these exact strings. */
export const OPTIONS = {
  allow: 'Allow once',
  decline: 'Not now',
  auto: 'Always allow (this session)',
}

/**
 * Marker carried by the wrapper method this guard installs. `Symbol.for` because
 * the host half (a profile's installed package) and the engine half (a preset
 * row, possibly another copy of this plugin) must recognize each other's work.
 */
export const GATE_MARK = Symbol.for('dsh-cache-guard.gate')

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
  const meter = ctx.get('tokenMeter')
  const { provider, model, contextWindow } = routedTarget(session)
  const measurement = meter.measure(session)
  const split = splitMeasurement(measurement)
  return {
    measurement,
    envelopeTokens: sessionEnvelopeTokens(session),
    // The guard picks the range itself, so it mirrors the harness's safe-cut rule.
    balancedCuts: balancedCuts(split.nodes, session.events),
    contextWindow,
    config: engine.config,
    provider,
    model,
    trigger,
    toolResults: surfaceToolResults(session),
    pruneContent: pruner === undefined ? () => null : blocks => pruner.pruneContent(blocks),
    estimateMessage: message => meter.estimateMessage(message),
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
/**
 * Decide one pending operation, record what was priced, and report the answer.
 *
 * The result is a decision about the WHOLE operation — pruning and the
 * summarization in the same transaction — because that is the only shape that
 * pays the provider's cache break once.
 *
 * @param input the engine, its ctx, the shared policy store, the agent, and the config.
 * @returns `'allowed'` to run the operation, `'declined'` to leave the surface untouched.
 */
export async function decide({ ctx, engine, policy, agent, session, sessionId, trigger, config, logger, onPlan }) {
  const inputs = planInputs({ ctx, engine, session, trigger, estimatedSummaryTokens: config.estimatedSummaryTokens })
  const plan = planChange(inputs)
  plan.kind = trigger === 'context-overflow' ? 'context-overflow' : plan.kind
  onPlan?.(plan)
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

  // Below the trigger there is nothing to decide; without a span there is
  // nothing the guard may do, because it never prunes on its own.
  if (!changing || plan.summary === null) {
    if (plan.kind !== 'below-threshold') {
      logger.info(`cache-guard: no summarizable range at ${plan.totalTokens} tokens; leaving the surface untouched`)
    }
    return 'declined'
  }

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
 * Run the operation the guard decided on: the summarization transaction first,
 * then the model-free pruning.
 *
 * That order is what makes one cache break suffice. `compactRegion` replaces the
 * selected span with a checkpoint, which invalidates the provider's prefix from
 * the oldest replaced position on; every pruning rewrite that follows sits behind
 * that break and adds nothing to it. The reverse order would pay the break twice
 * when the summary lands anyway, and would leave a pruned surface behind if the
 * range were rejected. This transaction is atomic, so a rejected range throws
 * before anything is written.
 *
 * @param input the ctx, the wrapped engine, the agent and session to operate on, the plan, the signal, and a logger.
 * @returns the engine's own compaction result, for the calling listener to log.
 */
export async function runOperation({ ctx, engine, agent, session, plan, signal, logger }) {
  const summary = plan.summary
  if (summary === null) return null
  // The wrapped instance is the operation's owner; the ctx read keeps a
  // deployment whose `compaction` service is a different object working.
  const target = ctx.get?.('compaction') ?? engine
  if (target === undefined) return null
  const result = await target.compactRegion(summary.startSeq, summary.endSeq, agent, signal)
  const pruner = ctx.get('toolResultPruner')
  if (pruner !== undefined) {
    try {
      const pruned = pruner.pruneSession(session)
      if (pruned.pruned.length > 0) {
        logger.info(`cache-guard: pruned ${pruned.pruned.length} tool results `
          + `(${formatTokens(plan.freedByPrune)} planned) behind the checkpoint`)
      }
    } catch (error) {
      // The checkpoint already landed and is the durable, correct outcome; the
      // pruning is the optional second phase, so its failure must not undo it.
      logger.warn(`cache-guard: pruning after the checkpoint failed: `
        + `${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

/**
 * Wrap one engine instance's automatic compaction decisions.
 *
 * The wrapper never calls the original method: it either runs the combined
 * operation through the engine's public `compactRegion` and the pruner, or it
 * returns `null`, which the calling listeners read as "nothing to compact". That
 * is what keeps the harness from running its own prune-only pass behind the
 * guard's back.
 *
 * Two exceptions, both deliberate: `off` mode and a pricing failure hand the
 * decision back to the engine's own method. A guard that cannot price an
 * operation must not decide it, because the alternative — treating its own
 * failure as a decline — would silently stop compaction in every session it
 * guards.
 *
 * An engine is wrapped at most once per process. The marker sits on the wrapper
 * FUNCTION rather than on the instance: the two halves of this plugin reach an
 * engine through different handles (the host plane the raw instance, a preset
 * row the traced service), and only the stored method is the same object through
 * both. `Symbol.for` keeps the two halves agreeing even when the host half comes
 * from the npm package and the row from a profile's own copy of the plugin.
 *
 * @param input the engine, its ctx, the shared policy store, config, logger, and who installs.
 * @returns a disposer that restores the original method.
 */
export function installGate({ ctx, engine, policy, config, logger, owner = 'preset row' }) {
  const current = engine.compactIfNeeded
  if (typeof current === 'function' && current[GATE_MARK] !== undefined) {
    logger.info?.(`cache-guard: this engine is already guarded by the ${current[GATE_MARK]}; `
      + `the ${owner} adds nothing`)
    return () => {}
  }
  const original = current
  const gated = async function gated(agent, trigger, signal) {
    const session = agent?.session
    if (session === undefined) return null
    const sessionId = String(session.id ?? 'unknown')
    // `off` is the documented way out: the engine keeps its own behavior, and
    // nothing is priced, asked, or recorded for this session.
    if (policy.mode(sessionId) === 'off') return original.apply(this, [agent, trigger, signal])
    let decision
    let plan
    try {
      decision = await decide({
        ctx,
        engine: this,
        policy,
        agent,
        session,
        sessionId,
        trigger,
        config,
        logger,
        onPlan: priced => { plan = priced },
      })
    } catch (error) {
      logger.warn(`cache-guard: pricing failed (${error instanceof Error ? error.message : String(error)}); `
        + 'the engine decides this one itself')
      return original.apply(this, [agent, trigger, signal])
    }
    if (decision === 'declined') return null
    return runOperation({ ctx, engine: this, agent, session, plan, signal, logger })
  }
  gated[GATE_MARK] = owner
  engine.compactIfNeeded = gated
  policy.recordEngines((policy.engines?.() ?? 0) + 1)
  return () => {
    // Identity of the stored method is not a usable test: a traced service read
    // hands back a fresh wrapper for the same function on every read. The marker
    // on the wrapper is what tells this disposer its own work is still in place.
    const current = engine.compactIfNeeded
    if (typeof current !== 'function' || current[GATE_MARK] !== owner) return
    engine.compactIfNeeded = original
    policy.recordEngines(Math.max(0, (policy.engines?.() ?? 1) - 1))
  }
}
