/**
 * Simulation: what would the guard have shown, on a real session?
 *
 *   node tools/simulate-session.mjs [sessionIdSubstring]
 *
 * It loads a real session log, truncates it to the moment before the first
 * automatic surface rewrite, rebuilds a real `Session` from that prefix, prices
 * the pending plan through the real token meter and the real tool-result pruner,
 * and compares the prediction with what the log says actually happened.
 *
 * Read-only: nothing is written, no session is appended to.
 *
 * @module dsh-cache-guard/tools/simulate-session
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { decodeStorageRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { pricePlan, formatTokens, splitMeasurement } from '../lib/cold-cost.js'
import { planChange } from '../lib/plan.js'
import { describe as describePlan, planInputs, routedTarget, sessionEnvelopeTokens } from '../lib/gate.js'

const ROOT = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const NEEDLE = process.argv[2] ?? '02abdc01'

/** Session logs are appended as flushed (non-final) zstd frames. */
function decode(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let at = buffer.indexOf(MAGIC, 0); at !== -1; at = buffer.indexOf(MAGIC, at + 4)) starts.push(at)
  const parts = []
  let index = 0
  while (index < starts.length) {
    const start = starts[index]
    let end = starts[index + 1] ?? buffer.length
    let decoded
    while (true) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(start, end), { finishFlush: constants.ZSTD_e_FLUSH })
        break
      } catch (error) {
        if (index + 1 >= starts.length) throw error
        index += 1
        end = starts[index + 1] ?? buffer.length
      }
    }
    parts.push(decoded.toString('utf8'))
    index += 1
  }
  return parts.join('')
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name === 'session.jsonl.zstd') out.push(full)
  }
  return out
}

const file = walk(ROOT).find(candidate => candidate.includes(NEEDLE))
if (file === undefined) throw new Error(`no session log matching "${NEEDLE}" under ${ROOT}`)
const lines = decode(file).split('\n').filter(line => line.trim() !== '')
const header = JSON.parse(lines[0])
// Physical rows pack chunk runs; the seed needs the logical events they decode to.
const events = lines.slice(1)
  .flatMap(line => decodeStorageRecord(JSON.parse(line)))
  .filter(event => typeof event.seq === 'number')
const rewrites = events.filter(event => event.type === 'compaction/prune' || event.type === 'compaction/start')

console.log(`session ${header.id}`)
console.log(`  cwd        ${header.cwd}`)
console.log(`  events     ${events.length}`)
console.log(`  size       ${(statSync(file).size / 1e6).toFixed(1)} MB`)
if (rewrites.length === 0) {
  console.log('  no automatic surface rewrite in this session — nothing to simulate')
  process.exit(0)
}

const firstRewrite = rewrites[0]
const before = events.filter(event => event.seq < firstRewrite.seq)
console.log(`  first automatic rewrite at seq ${firstRewrite.seq} (${firstRewrite.type})`)
console.log(`  simulating just before it: ${before.length} events`)

const session = Session.create(SessionId(header.id), before)
const ctx = new Context()
await ctx.plugin(TokenMeter)
await ctx.plugin(ToolResultPruner)

const meter = ctx.tokenMeter
const measurement = meter.measure(session)
const target = routedTarget(session)
console.log(`\n  routed model   ${target.provider}/${target.model}`)
console.log(`  contextWindow  ${target.contextWindow}`)
console.log(`  measured       ${measurement.totalTokens} total / ${measurement.surfaceTokens} surface`
  + ` (residual ${measurement.totalTokens - measurement.surfaceTokens})`)
console.log(`  baseline       ${JSON.stringify(measurement.baseline)}`)
const allUsage = events.filter(event => event.type === 'assistant/message' && event.data?.usage !== undefined)
const totals = allUsage.map(event => (event.data.usage.inputTokens ?? 0) + (event.data.usage.cacheReadTokens ?? 0))
console.log(`  request totals min ${Math.min(...totals)} / first ${totals[0]} / max ${Math.max(...totals)}`)

const config = { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [] }
// Use the production input assembly, so the simulation validates it and not a copy.
const inputs = planInputs({
  ctx,
  engine: { config },
  session,
  trigger: 'pressure',
  estimatedSummaryTokens: 4_000,
})
const plan = planChange(inputs)

console.log(`\n--- what the guard would have shown ---`)
console.log(describePlan(plan, { pricePerMTokens: undefined }))

// What actually happened, from the full log.
const burst = events.filter(event => event.type === 'compaction/prune' && Math.abs(event.seq - firstRewrite.seq) < 200)
const burstShadowed = burst.reduce((total, event) => total + (event.data?.shadowedTokenCount ?? 0), 0)
const summaries = events.filter(event => event.type === 'compaction/summary')
const usage = events.filter(event => event.type === 'assistant/message' && event.data?.usage !== undefined)
const total = event => (event.data.usage.inputTokens ?? 0) + (event.data.usage.cacheReadTokens ?? 0)
const beforeRewrite = usage.filter(event => event.seq < firstRewrite.seq).at(-1)
const afterRewrite = usage.find(event => event.seq > (burst.at(-1)?.seq ?? firstRewrite.seq))

console.log(`\n--- what the log says happened ---`)
console.log(`  rewrites in the burst      ${burst.length} (priced ${burstShadowed} tokens)`)
console.log(`  summary compactions        ${summaries.length}`)
console.log(`  request before             ${total(beforeRewrite)} tokens`
  + ` (${beforeRewrite.data.usage.cacheReadTokens ?? 0} cached)`)
console.log(`  request after              ${total(afterRewrite)} tokens`
  + ` (${afterRewrite.data.usage.cacheReadTokens ?? 0} cached, ${afterRewrite.data.usage.inputTokens ?? 0} full price)`)

console.log(`\n--- verdict ---`)
console.log(`  predicted rewrites         ${plan.pruned.length}`)
console.log(`  predicted first change     position ${plan.estimate.firstChangedPosition} (seq ${plan.estimate.firstChangedSeq})`)
console.log(`  predicted warm             ${plan.estimate.warmTokens} tokens`)
console.log(`  predicted cold             ${plan.estimate.coldTokens} tokens`)
console.log(`  actual cached after        ${afterRewrite.data.usage.cacheReadTokens ?? 0} tokens`)
console.log(`  actual full price after    ${afterRewrite.data.usage.inputTokens ?? 0} tokens`)

// The same need, met from the NEWEST end: free only as much as the threshold
// requires, starting at the tail, so the cache breaks as late as possible. The
// cache cost of a rewrite is its POSITION, not its size.
const needed = Math.max(0, measurement.totalTokens - plan.thresholdTokens)
const fromNewest = []
let freed = 0
for (let index = plan.pruned.length - 1; index >= 0 && freed < needed; index -= 1) {
  const entry = plan.pruned[index]
  fromNewest.push({ seq: entry.seq, tokens: entry.after })
  freed += entry.before - entry.after
}
const split = splitMeasurement(measurement)
if (fromNewest.length > 0 && freed >= needed) {
  const alternative = pricePlan(split.nodes, sessionEnvelopeTokens(session), {
    rewrites: fromNewest,
    totalBeforeTokens: measurement.totalTokens,
  })
  console.log(`\n--- the same need, pruned from the newest end ---`)
  console.log(`  needed                     ${needed} tokens to reach the threshold`)
  console.log(`  rewrites                   ${fromNewest.length} of ${plan.pruned.length}`)
  console.log(`  predicted first change     position ${alternative.firstChangedPosition} of ${split.nodes.length}`)
  console.log(`  predicted cold             ${alternative.coldTokens} tokens`
    + ` (${formatTokens(alternative.coldTokens)} instead of ${formatTokens(plan.estimate.coldTokens)})`)
} else {
  console.log(`\n--- newest-end pruning ---`)
  console.log(`  would not reach the threshold on its own (${freed} of ${needed} tokens from ${fromNewest.length} results)`)
}
