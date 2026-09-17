/**
 * Cold re-read pricing for one planned surface change.
 *
 * A provider reuses its cached prefix only up to the last unchanged token, so a
 * rewrite at surface position P makes every token from P on a cache miss. These
 * functions price that miss before the rewrite happens, using the harness's own
 * per-node token prices (`ctx.tokenMeter.measure(session).nodes`), so the number
 * shown to a human and the number the engine acts on come from one estimator.
 *
 * @module dsh-cache-guard/cold-cost
 */

/** Sum one price list over an inclusive index range. */
function sum(values, from = 0, to = values.length - 1) {
  let total = 0
  for (let index = from; index <= to; index += 1) total += values[index] ?? 0
  return total
}

/**
 * Price the request that follows a planned change.
 *
 * The split is computed in two currencies on purpose. The request TOTAL comes
 * from the harness's own pressure number, which is anchored to the provider's
 * reported usage whenever a session has one; the WARM part comes from positional
 * node prices. Measured on a real session, that combination predicted a full-price
 * re-read of 724k against an actual 721k, while deriving the fixed part from the
 * meter's residual instead (97k rather than the true 14k) missed by 12%.
 *
 * @param nodes priced surface in model-visible order.
 * @param envelopeTokens cache-stable request part: system prompt, tools, and the
 *   opening message, measured from the cheapest real request of the session.
 * @param plan `{ rewrites?, span?, totalBeforeTokens? }`; `rewrites` carries each
 *   rewritten node's price AFTER the rewrite, `span` replaces the inclusive range
 *   with one checkpoint node (subsuming any rewrite inside it), and
 *   `totalBeforeTokens` is the request pressure measured BEFORE the change.
 * @returns warm, cold, total, and freed token counts plus the position of the earliest change.
 */
export function pricePlan(nodes, envelopeTokens, plan) {
  const rewrites = new Map((plan.rewrites ?? []).map(rewrite => [rewrite.seq, rewrite.tokens]))
  const span = plan.span
  const startIndex = span === undefined ? -1 : nodes.findIndex(node => node.seq === span.startSeq)
  const endIndex = span === undefined ? -1 : nodes.findIndex(node => node.seq === span.endSeq)
  const spanApplies = startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex

  let firstIndex = -1
  for (let index = 0; index < nodes.length; index += 1) {
    if (rewrites.has(nodes[index].seq)) {
      firstIndex = index
      break
    }
  }
  if (spanApplies && (firstIndex === -1 || startIndex < firstIndex)) firstIndex = startIndex
  if (firstIndex === -1) return empty(envelopeTokens, nodes)

  const prices = []
  for (let index = 0; index < nodes.length; index += 1) {
    if (spanApplies && index === startIndex) {
      prices.push(span.checkpointTokens)
      index = endIndex
      continue
    }
    const rewritten = rewrites.get(nodes[index].seq)
    prices.push(rewritten ?? nodes[index].tokens)
  }

  const before = sum(nodes.map(node => node.tokens))
  const after = sum(prices)
  const freedTokens = before - after
  const totalTokens = plan.totalBeforeTokens === undefined
    ? envelopeTokens + after
    : plan.totalBeforeTokens - freedTokens
  const warmTokens = envelopeTokens + sum(nodes.map(node => node.tokens), 0, firstIndex - 1)
  return {
    firstChangedSeq: nodes[firstIndex].seq,
    firstChangedPosition: firstIndex,
    /** Tokens the next request reuses from the provider cache. */
    warmTokens,
    /** Tokens the next request pays at full price because the prefix broke here. */
    coldTokens: Math.max(0, totalTokens - warmTokens),
    /** Full size of the next request. */
    totalTokens,
    /** Tokens the operation removes from the surface. */
    freedTokens,
  }
}

/**
 * Price the request that follows a set of rewritten nodes.
 * @param nodes priced surface in model-visible order.
 * @param envelopeTokens cache-stable request part.
 * @param changes rewritten nodes: `{ seq, tokens }` with the price after the rewrite.
 * @returns the plan priced by {@link pricePlan}.
 */
export function priceNodeRewrites(nodes, envelopeTokens, changes) {
  return pricePlan(nodes, envelopeTokens, { rewrites: changes })
}

/**
 * Price the request that follows replacing a span with one checkpoint node.
 * @param nodes priced surface in model-visible order.
 * @param envelopeTokens cache-stable request part.
 * @param startSeq first replaced surface node, inclusive.
 * @param endSeq last replaced surface node, inclusive.
 * @param checkpointTokens price of the summary node that takes the span's place.
 * @returns the plan priced by {@link pricePlan}.
 */
export function priceSpanReplacement(nodes, envelopeTokens, startSeq, endSeq, checkpointTokens) {
  return pricePlan(nodes, envelopeTokens, { span: { startSeq, endSeq, checkpointTokens } })
}

/** Result of a plan that changes nothing. */
function empty(envelopeTokens, nodes) {
  const surface = sum(nodes.map(node => node.tokens))
  return {
    firstChangedSeq: undefined,
    firstChangedPosition: undefined,
    warmTokens: envelopeTokens + surface,
    coldTokens: 0,
    totalTokens: envelopeTokens + surface,
    freedTokens: 0,
  }
}

/**
 * Split a token measurement into its fixed request envelope and its surface.
 * @param measurement `ctx.tokenMeter.measure(session)` result.
 * @returns the envelope price (never negative) and the surfaced nodes.
 */
export function splitMeasurement(measurement) {
  return {
    envelopeTokens: Math.max(0, measurement.totalTokens - measurement.surfaceTokens),
    nodes: measurement.nodes.map(node => ({ seq: node.seq, tokens: node.tokens })),
  }
}

/**
 * Render a token count the way a cost dialog reads it.
 * @param tokens token count.
 * @returns e.g. `820`, `737k`, `1.05M`.
 */
export function formatTokens(tokens) {
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/**
 * Price one token count with a configured per-million rate, rounded to a
 * displayable precision so a shown cost carries no floating-point residue.
 * @param tokens token count.
 * @param perMillion price per one million tokens.
 * @returns `undefined` when no rate is configured, else the cost in currency units.
 */
export function costOf(tokens, perMillion) {
  if (typeof perMillion !== 'number' || !Number.isFinite(perMillion)) return undefined
  return Math.round(tokens / 1_000_000 * perMillion * 1e6) / 1e6
}
