/**
 * What the engine is about to do, priced before it happens.
 *
 * `compaction-basic` decides inside one call: it first rewrites oversized tool
 * results, then — only if the surface is still above the pressure threshold —
 * replaces an older span with a summary checkpoint. This module reproduces that
 * plan from the public inputs (priced surface, engine config, pruner, routed
 * window) without touching the session, so a human can accept or decline it.
 *
 * The threshold and retention arithmetic mirrors `resolveTargetPolicy` and
 * `resolveCompactSpec` in `@deepseek-ai/dsh-compaction-basic`. A change there
 * must be followed here.
 *
 * @module dsh-cache-guard/plan
 */
import { pricePlan, splitMeasurement } from './cold-cost.js'

/** Policy fields for one routed provider/model, mirroring the engine's own resolution. */
export function resolveBudgets(config, provider, model, contextWindow) {
  const target = (config.modelPolicies ?? []).find(
    policy => policy.provider === provider && policy.model === model,
  )
  const thresholdRatio = target?.thresholdRatio ?? config.thresholdRatio
  const retainRatio = target?.retainRatio ?? config.retainRatio
  const retainTokens = target?.retainTokens ?? config.retainTokens
  const window = contextWindow
  return {
    thresholdRatio,
    thresholdTokens: window === undefined ? Math.floor(config.thresholdRatio * 0) : Math.floor(window * thresholdRatio),
    retainTokens: retainTokens ?? (window === undefined ? 0 : Math.floor(window * (retainRatio ?? 0))),
    retainIsAbsolute: retainTokens !== undefined,
    window,
  }
}

/** Price one tool result as the pruner would leave it, or `null` when it is within budget. */
function priceCandidate(candidate, pruneContent, estimateMessage) {
  const message = candidate.message
  const result = message?.content?.[0]
  if (result === undefined || !Array.isArray(result.content)) return null
  const pruned = pruneContent(result.content)
  if (pruned === null || pruned === undefined) return null
  const before = estimateMessage(message)
  const after = estimateMessage({ ...message, content: [{ ...result, content: pruned }] })
  if (after >= before) return null
  return { seq: candidate.seq, before, after }
}

/** Walk the tail keeping whole nodes while they fit the retention budget. */
export function retainedTailStart(prices, retainTokens) {
  let index = prices.length
  let kept = 0
  while (index > 0 && kept + prices[index - 1] <= retainTokens) {
    index -= 1
    kept += prices[index]
  }
  return index
}

/**
 * Which cuts of one surface fall between a tool call and its result.
 *
 * The harness derives safe cuts from tool-call/result content in current surface
 * order rather than from step markers (`toolPairingBalancedBefore` in
 * `@deepseek-ai/dsh-compaction`): an assistant message adds one in-progress call
 * per `tool-call` block, a tool result closes one, and a cut is balanced exactly
 * where the count is zero. The guard mirrors that rule because it now selects the
 * range itself; a change upstream has to be followed here.
 *
 * @param nodes - the priced surface, in model-visible order.
 * @param events - the session's events, indexed by seq.
 * @returns `nodes.length + 1` flags: entry `i` is the cut BEFORE node `i`, the last is the cut after the tail.
 */
export function balancedCuts(nodes, events) {
  if (!Array.isArray(events)) return nodes.map(() => true).concat(true)
  const cuts = []
  let inProgress = 0
  for (const node of nodes) {
    cuts.push(inProgress === 0)
    const event = events[node.seq]
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (Array.isArray(content)) {
        inProgress += content.filter(block => block?.type === 'tool-call').length
      }
    } else if (event?.type === 'tool/result') {
      inProgress -= 1
    }
  }
  cuts.push(inProgress === 0)
  return cuts
}

/**
 * The boundary the span ends at: everything older than the retained tail goes.
 * @param input the priced surface, its prices, the trigger, the budget, and the cut flags.
 * @returns the index of the first retained node, or 0 when nothing can be cut.
 */
function cutBoundary({ nodes, prices, overflow, retainTokens, balanced }) {
  let keepFrom = overflow ? prices.length - 1 : retainedTailStart(prices, retainTokens)
  // Move the boundary toward the OLDER end until it lands on a balanced cut, the
  // same direction the harness moves it: keeping more is the safe repair.
  const flag = index => balanced?.[index] ?? true
  while (keepFrom > 0 && !flag(keepFrom)) keepFrom -= 1
  return keepFrom
}

/**
 * Build the plan for one pending automatic operation.
 * @param input priced surface, routed window, engine config, pruner, estimator,
 *   and optionally `envelopeTokens`: the session's fixed request part measured
 *   from its cheapest real request. Without it the meter's residual is used,
 *   which on a provider-anchored session overstates the fixed part.
 * @returns the plan: what would be freed, what would break the prefix, and what the next request pays cold.
 */
export function planChange(input) {
  const { measurement, config, provider, model, estimateMessage, pruneContent } = input
  const budgets = resolveBudgets(config, provider, model, input.contextWindow)
  const split = splitMeasurement(measurement)
  const envelopeTokens = input.envelopeTokens ?? split.envelopeTokens
  const nodes = split.nodes
  const context = {
    trigger: input.trigger,
    provider,
    model,
    totalTokens: measurement.totalTokens,
    contextWindow: budgets.window,
    thresholdTokens: budgets.thresholdTokens,
    retainTokens: budgets.retainTokens,
    matchesThreshold: measurement.totalTokens >= budgets.thresholdTokens,
  }

  if (input.trigger === 'pressure' && !context.matchesThreshold) {
    return { ...context, kind: 'below-threshold', pruned: [], estimate: null }
  }

  const pruned = []
  for (const candidate of input.toolResults) {
    const priced = priceCandidate(candidate, pruneContent, estimateMessage)
    if (priced !== null) pruned.push(priced)
  }

  const prices = nodes.map(node => {
    const rewrite = pruned.find(entry => entry.seq === node.seq)
    return rewrite === undefined ? node.tokens : rewrite.after
  })
  const freedByPrune = pruned.reduce((total, entry) => total + (entry.before - entry.after), 0)
  const afterPruneTokens = measurement.totalTokens - freedByPrune

  // The guard owns the operation, so it always pairs pruning with a
  // summarization: one cache break, once, and a surface that actually shrinks.
  // The span is therefore planned whenever the pressure qualifies — including
  // the case where pruning alone would have got below the threshold, which the
  // guard deliberately does not take on its own.
  let summary = null
  const overflow = input.trigger === 'context-overflow'
  if (overflow || measurement.totalTokens >= budgets.thresholdTokens) {
    const keepFrom = cutBoundary({
      nodes,
      prices,
      overflow,
      retainTokens: budgets.retainTokens,
      balanced: input.balancedCuts,
    })
    if (keepFrom > 0) {
      summary = {
        startSeq: nodes[0].seq,
        endSeq: nodes[keepFrom - 1].seq,
        retainedNodes: nodes.length - keepFrom,
        checkpointTokens: input.estimatedSummaryTokens,
      }
    }
  }

  const estimate = pricePlan(nodes, envelopeTokens, {
    rewrites: pruned.map(entry => ({ seq: entry.seq, tokens: entry.after })),
    totalBeforeTokens: measurement.totalTokens,
    ...summary === null ? {} : { span: summary },
  })

  return {
    ...context,
    kind: summary === null ? (pruned.length === 0 ? 'nothing' : 'prune-only') : 'prune-and-summarize',
    pruned,
    freedByPrune,
    afterPruneTokens,
    summary,
    estimate,
  }
}
