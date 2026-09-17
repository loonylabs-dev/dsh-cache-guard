/**
 * Unit tests for the planned-change pricing.
 *
 *   node test/plan.test.mjs
 *
 * Fixtures keep a node's price equal to the price of the message it carries,
 * which is what the meter's own fold guarantees in a real session.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planChange, resolveBudgets, retainedTailStart } from '../lib/plan.js'

/** Priced surface: one node per price, seq assigned by position. */
function priced(prices) {
  return prices.map((tokens, seq) => ({ seq, tokens }))
}

/** A tool result whose single text block is `chars` long. */
function toolResult(seq, chars) {
  return {
    seq,
    message: { role: 'tool', content: [{ type: 'text', content: [{ type: 'text', text: 'x'.repeat(chars) }] }] },
  }
}

/** Prune everything over 1000 chars down to 100. */
function pruneContent(blocks) {
  const text = blocks[0].text
  if (text.length <= 1000) return null
  return [{ type: 'text', text: text.slice(0, 100) }]
}

/** Price a message by its text length, standing in for the meter's heuristic. */
function estimateMessage(message) {
  return message.content[0].content.map(block => block.text ?? '').join('').length
}

const ENGINE_CONFIG = { thresholdRatio: 0.9, retainRatio: 0.2, modelPolicies: [] }

function measurementOf(nodes, envelopeTokens) {
  const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
  return { nodes, surfaceTokens, totalTokens: envelopeTokens + surfaceTokens }
}

/** 60k prunable result + ten 80k nodes + 40k envelope = 900k, exactly the threshold. */
const THRESHOLD_NODES = priced([60_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000, 80_000])

function planFor(toolResults, overrides = {}) {
  return planChange({
    measurement: measurementOf(overrides.nodes ?? THRESHOLD_NODES, 40_000),
    contextWindow: 1_000_000,
    config: ENGINE_CONFIG,
    trigger: 'pressure',
    provider: 'p',
    model: 'm',
    pruneContent,
    estimateMessage,
    estimatedSummaryTokens: 4_000,
    toolResults,
    ...overrides,
  })
}

describe('resolveBudgets', () => {
  it('scales the threshold and retention from the routed window', () => {
    const budgets = resolveBudgets({ thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] }, 'p', 'm', 1_048_576)
    assert.equal(budgets.thresholdTokens, 838_860)
    assert.equal(budgets.retainTokens, 167_772)
  })

  it('lets an exact routed target override the defaults', () => {
    const budgets = resolveBudgets({
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5, retainTokens: 1000 }],
    }, 'p', 'm', 100_000)
    assert.equal(budgets.thresholdTokens, 50_000)
    assert.equal(budgets.retainTokens, 1000)
    assert.equal(budgets.retainIsAbsolute, true)
  })
})

describe('retainedTailStart', () => {
  it('keeps whole nodes from the tail while they fit the budget', () => {
    assert.equal(retainedTailStart([10, 10, 10, 10], 25), 2)
    assert.equal(retainedTailStart([10, 10, 10, 10], 40), 0)
    assert.equal(retainedTailStart([10, 10], 0), 2)
  })
})

describe('planChange', () => {
  it('reports nothing to do below the threshold', () => {
    const plan = planFor([toolResult(0, 60_000)], { nodes: priced([80_000, 80_000]) })
    assert.equal(plan.kind, 'below-threshold')
    assert.equal(plan.estimate, null)
  })

  it('prices a prune-only change from the OLDEST rewritten node', () => {
    const plan = planFor([toolResult(0, 60_000)])
    assert.equal(plan.kind, 'prune-only')
    assert.equal(plan.pruned.length, 1)
    assert.equal(plan.freedByPrune, 59_900)
    assert.equal(plan.summary, null)
    assert.equal(plan.estimate.firstChangedPosition, 0)
    assert.equal(plan.estimate.coldTokens, 100 + 10 * 80_000)
    assert.equal(plan.estimate.warmTokens, 40_000)
    assert.equal(plan.estimate.freedTokens, 59_900)
  })

  it('prices rewriting the NEWEST node at a fraction of the oldest one', () => {
    const plan = planFor([toolResult(10, 80_000)])
    assert.equal(plan.kind, 'prune-only')
    assert.equal(plan.estimate.firstChangedPosition, 10)
    assert.equal(plan.estimate.coldTokens, 100)
    assert.equal(plan.estimate.warmTokens, 40_000 + 60_000 + 9 * 80_000)
  })

  it('adds a summary span when pruning alone stays above the threshold', () => {
    // 60k prunable + sixteen 80k nodes + 40k envelope = 1.38M against a 900k threshold.
    const nodes = priced([60_000, ...Array.from({ length: 16 }, () => 80_000)])
    const plan = planFor([toolResult(0, 60_000)], { nodes })
    assert.equal(plan.kind, 'prune-and-summarize')
    assert.equal(plan.afterPruneTokens, 1_380_000 - 59_900)
    // Retention keeps the two newest 80k nodes; everything older becomes a 4k checkpoint.
    assert.equal(plan.summary.retainedNodes, 2)
    assert.equal(plan.summary.startSeq, 0)
    assert.equal(plan.summary.endSeq, 14)
    assert.equal(plan.estimate.firstChangedPosition, 0)
    assert.equal(plan.estimate.coldTokens, 4_000 + 2 * 80_000)
    assert.equal(plan.estimate.freedTokens, 1_340_000 - (4_000 + 2 * 80_000))
  })

  it('forces a span on provider overflow even below the pressure threshold', () => {
    const plan = planFor([], { nodes: priced([80_000, 80_000, 80_000, 80_000, 80_000, 80_000]), trigger: 'context-overflow' })
    assert.equal(plan.kind, 'prune-and-summarize')
    assert.equal(plan.summary.startSeq, 0)
    assert.equal(plan.summary.endSeq, 4)
    assert.equal(plan.estimate.coldTokens, 4_000 + 80_000)
  })

  it('matches the measured real case once the true fixed part is supplied', () => {
    // Measured on session-02abdc01 (1M window, deepseek-v4.1-flash): the engine
    // rewrote 28 old tool results at surface position 8, and the next request
    // re-read 720,764 tokens at full price. The meter's residual (97,450) is not
    // the fixed part; the session's cheapest real request (14,215) is.
    const prices = [30_000, ...Array.from({ length: 39 }, () => 18_000)]
    const nodes = priced(prices)
    const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
    const plan = planChange({
      measurement: { nodes, surfaceTokens, totalTokens: 839_046 },
      envelopeTokens: 14_215,
      contextWindow: 1_048_576,
      config: { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] },
      trigger: 'pressure',
      provider: 'requesty/deepseek/deepseek-v4.1-flash',
      model: 'deepseek-v4.1-flash',
      pruneContent: blocks => blocks[0].text.length > 1000 ? [{ type: 'text', text: blocks[0].text.slice(0, 100) }] : null,
      estimateMessage,
      estimatedSummaryTokens: 4_000,
      toolResults: [toolResult(0, 30_000)],
    })
    assert.equal(plan.kind, 'prune-only')
    assert.equal(plan.estimate.firstChangedPosition, 0)
    assert.equal(plan.estimate.warmTokens, 14_215)
    assert.equal(plan.estimate.totalTokens, 839_046 - (30_000 - 100))
    assert.equal(plan.estimate.coldTokens, 839_046 - (30_000 - 100) - 14_215)
    assert.ok(plan.estimate.coldTokens > 700_000, 'the cold read must dominate the request')
  })

  it('still plans a summary when no tool result is over the pruner budget', () => {
    const nodes = priced(Array.from({ length: 16 }, () => 80_000))
    const plan = planFor([toolResult(0, 500)], { nodes })
    assert.equal(plan.kind, 'prune-and-summarize')
    assert.equal(plan.pruned.length, 0)
    assert.equal(plan.freedByPrune, 0)
  })
})
