/**
 * Unit tests for the cold re-read pricing.
 *
 *   node --test test/cold-cost.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  costOf, formatTokens, priceNodeRewrites, priceSpanReplacement, splitMeasurement,
} from '../lib/cold-cost.js'

/** Priced surface of `count` equal nodes. */
function surface(count, tokens) {
  return Array.from({ length: count }, (_unused, index) => ({ seq: index, tokens }))
}

describe('priceNodeRewrites', () => {
  it('prices the whole tail from the FIRST rewritten node, not from the newest one', () => {
    // The measured shape of the real case: rewriting the oldest results keeps
    // almost nothing warm, which is what made that request cost 40x.
    const nodes = surface(3, 100_000)
    const oldest = priceNodeRewrites(nodes, 24_000, [{ seq: 0, tokens: 5_000 }])
    assert.equal(oldest.firstChangedSeq, 0)
    assert.equal(oldest.warmTokens, 24_000)
    assert.equal(oldest.coldTokens, 5_000 + 100_000 + 100_000)
    assert.equal(oldest.freedTokens, 95_000)

    const newest = priceNodeRewrites(nodes, 24_000, [{ seq: 2, tokens: 5_000 }])
    assert.equal(newest.warmTokens, 24_000 + 100_000 + 100_000)
    assert.equal(newest.coldTokens, 5_000)
    assert.equal(newest.freedTokens, 95_000)
  })

  it('takes the earliest change when several nodes are rewritten', () => {
    const plan = priceNodeRewrites(surface(4, 50_000), 10_000, [
      { seq: 3, tokens: 2_000 },
      { seq: 1, tokens: 2_000 },
    ])
    assert.equal(plan.firstChangedSeq, 1)
    assert.equal(plan.warmTokens, 10_000 + 50_000)
    assert.equal(plan.coldTokens, 2_000 + 50_000 + 2_000)
    assert.equal(plan.totalTokens, 10_000 + 50_000 + 2_000 + 50_000 + 2_000)
    assert.equal(plan.freedTokens, 96_000)
  })

  it('reports no cold tokens when nothing changes', () => {
    const plan = priceNodeRewrites(surface(2, 1_000), 500, [])
    assert.equal(plan.coldTokens, 0)
    assert.equal(plan.firstChangedSeq, undefined)
    assert.equal(plan.totalTokens, 2_500)
  })
})

describe('priceSpanReplacement', () => {
  it('keeps the prefix before the span warm and the checkpoint plus tail cold', () => {
    const plan = priceSpanReplacement(surface(10, 20_000), 24_000, 3, 7, 3_000)
    assert.equal(plan.firstChangedSeq, 3)
    assert.equal(plan.warmTokens, 24_000 + 60_000)
    assert.equal(plan.coldTokens, 3_000 + 40_000)
    assert.equal(plan.freedTokens, 100_000 - 3_000)
  })

  it('ignores a span whose edges are absent or reversed', () => {
    const plan = priceSpanReplacement(surface(3, 1_000), 100, 2, 1, 50)
    assert.equal(plan.coldTokens, 0)
    assert.equal(plan.totalTokens, 3_100)
  })
})

describe('splitMeasurement', () => {
  it('reads the envelope as the difference between request pressure and surface', () => {
    const split = splitMeasurement({
      totalTokens: 861_000,
      surfaceTokens: 837_168,
      nodes: [{ seq: 4, tokens: 12 }, { seq: 9, tokens: 34 }],
    })
    assert.equal(split.envelopeTokens, 23_832)
    assert.deepEqual(split.nodes, [{ seq: 4, tokens: 12 }, { seq: 9, tokens: 34 }])
  })
})

describe('formatting', () => {
  it('renders counts and optional costs', () => {
    assert.equal(formatTokens(820), '820')
    assert.equal(formatTokens(737_532), '738k')
    assert.equal(formatTokens(1_048_576), '1.05M')
    assert.equal(costOf(737_532, 0.14), 0.103254)
    assert.equal(costOf(1_000, undefined), undefined)
  })
})
