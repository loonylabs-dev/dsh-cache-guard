/**
 * dsh-cache-guard — host half.
 *
 * Holds the per-session guard policy, publishes it as `ctx.cacheGuard` for the
 * engine half inside the agent preset, and serves it to the browser half over
 * two small loopback endpoints.
 *
 * @module dsh-cache-guard
 */
import { resolveGuardConfig } from './lib/config.js'
import { registerCacheGuardRoutes } from './lib/host-routes.js'
import { createPolicyStore } from './lib/policy.js'

/** Cordis plugin name. */
export const name = 'dsh-cache-guard'

/** The web server is read lazily, so a profile without a web stack still mounts. */
export const inject = []

/**
 * Publish the guard policy.
 * @param ctx - host context.
 * @param config - plugin configuration; an unknown or out-of-range value fails loud here.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveGuardConfig(config)
  const store = createPolicyStore({ defaultMode: resolved.mode })
  ctx.provide('cacheGuard', {
    store,
    /** Effective mode of one session. */
    mode: sessionId => store.mode(String(sessionId)),
    /** Set the mode of one session. */
    setMode: (sessionId, next) => store.setMode(String(sessionId), next),
    /** The priced plan of the last decision in one session. */
    lastPlan: sessionId => store.lastPlan(String(sessionId)),
    /** Sessions the guard has seen. */
    sessions: () => store.sessionIds(),
    defaultMode: resolved.mode,
    estimatedSummaryTokens: resolved.estimatedSummaryTokens,
    pricePerMTokens: resolved.pricePerMTokens,
  })
  ctx.effect(() => {
    registerCacheGuardRoutes({ ctx, store, config: resolved, logger: ctx.logger ?? console })
    return () => {}
  }, 'dsh-cache-guard: host routes')
  if (ctx.logger?.info) ctx.logger.info(`dsh-cache-guard: host ready (default mode ${resolved.mode})`)
}
