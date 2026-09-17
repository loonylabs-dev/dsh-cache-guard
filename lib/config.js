/**
 * Guard configuration, validated loud at load.
 *
 * The package deliberately imports nothing: a plugin mounted from a profile or a
 * preset directory must not depend on how a deployment hoisted the harness's own
 * packages, so config is validated here instead of through a schema library.
 *
 * @module dsh-cache-guard/config
 */
import { MODES } from './policy.js'

/** Default assumed checkpoint size used when pricing a planned summarization. */
export const DEFAULT_SUMMARY_TOKENS = 4_000

/**
 * Resolve one guard configuration.
 * @param config - the row's config object.
 * @param fallback - values from the mounted host half, used when the row omits them.
 * @returns `{ mode, pricePerMTokens, estimatedSummaryTokens }`.
 * @throws when a value is unknown or out of range.
 */
export function resolveGuardConfig(config = {}, fallback = {}) {
  const mode = config.mode ?? fallback.mode ?? 'manual'
  if (!MODES.includes(mode)) {
    throw new Error(`dsh-cache-guard: unknown mode "${mode}" (expected ${MODES.join(' | ')})`)
  }
  const price = config.pricePerMTokens ?? fallback.pricePerMTokens
  if (price !== undefined && (typeof price !== 'number' || !Number.isFinite(price) || price < 0)) {
    throw new Error(`dsh-cache-guard: pricePerMTokens must be a non-negative number, got ${JSON.stringify(price)}`)
  }
  const summary = config.estimatedSummaryTokens ?? fallback.estimatedSummaryTokens ?? DEFAULT_SUMMARY_TOKENS
  if (!Number.isInteger(summary) || summary <= 0) {
    throw new Error(`dsh-cache-guard: estimatedSummaryTokens must be a positive integer, got ${JSON.stringify(summary)}`)
  }
  return { mode, pricePerMTokens: price, estimatedSummaryTokens: summary }
}
