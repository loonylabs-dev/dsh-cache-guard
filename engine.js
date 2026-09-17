/**
 * dsh-cache-guard — engine half.
 *
 * Mounted inside an agent preset next to the compaction plugin. It wraps the
 * live engine's `compactIfNeeded`, prices what that call is about to change, and
 * asks the human before the surface is rewritten — the step-pressure path and
 * the provider-overflow recovery path both go through that one method.
 *
 * Nothing is imported from the compaction packages: the wrapper only reads the
 * public config the engine already resolved and the public services of its ctx,
 * so it cannot bind to a second copy of a harness class.
 *
 * @module dsh-cache-guard/engine
 */
import { resolveGuardConfig } from './lib/config.js'
import { installGate } from './lib/gate.js'
import { createPolicyStore } from './lib/policy.js'

/** Cordis plugin name. */
export const name = 'dsh-cache-guard-engine'

/** The engine plus the meter it prices through; the guard is inert without both. */
export const inject = ['compaction', 'tokenMeter']

/**
 * Wrap the realm's compaction engine.
 * @param ctx - the preset realm's context.
 * @param config - plugin configuration; the mounted host half supplies the fallbacks.
 */
export function apply(ctx, config = {}) {
  const host = ctx.get('cacheGuard')
  const policy = host?.store ?? createPolicyStore({ defaultMode: config.mode ?? 'manual' })
  const resolved = resolveGuardConfig(config, host ?? {})
  const logger = ctx.logger ?? console
  const install = () => installGate({ ctx, engine: ctx.compaction, policy, config: resolved, logger })
  if (typeof ctx.effect === 'function') ctx.effect(install)
  else install()
  logger.info?.(`dsh-cache-guard: engine guarded (mode ${resolved.mode})`)
}
