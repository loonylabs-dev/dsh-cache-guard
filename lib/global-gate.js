/**
 * The host-plane interception: it guards the compaction engine of EVERY preset
 * realm, so installing the plugin protects every session instead of only the
 * sessions that happen to be composed on a preset carrying an engine row.
 *
 * An agent's engine is created inside its preset: the shipped `compaction` group
 * isolates `compaction` and `toolResultPruner`, so the instance is not the host
 * plane's service and a profile patch cannot reach it. A plain `internal/service`
 * listener does not hear the registration either — the event carries a scope
 * filter that drops every listener outside the providing realm. `{ global: true }`
 * is what bypasses exactly that filter, and it is the mechanism the harness's own
 * preset invariant uses to watch realm registrations.
 *
 * Only a registration is announced, never the instance the agent's listeners
 * call. Wrapping the announced instance is what makes the interception hold:
 * `compaction-basic` registers its listeners with `this` bound to that instance
 * and calls `this.compactIfNeeded(...)` internally, so replacing that one method
 * covers the step-pressure path and the provider-overflow path alike.
 *
 * @module dsh-cache-guard/global-gate
 */
import { GATE_MARK, installGate } from './gate.js'

/** The service name whose registration announces a compaction engine. */
export const ENGINE_SERVICE = 'compaction'

/**
 * Reads the instance behind a traced service value.
 *
 * Cordis announces services through a traced read: the value a listener receives
 * is a proxy whose `ctx` answers with the READING context, so pricing through
 * `value.ctx` would resolve the host plane's pruner and meter instead of the
 * engine's realm. The proxy exposes its target under this global-registry symbol,
 * which is also why nothing has to be imported to reach the real instance.
 */
export const ORIGINAL = Symbol.for('cordis.original')

/**
 * Guard every compaction engine this process creates, from now until disposal.
 * @param input the host context, the shared policy store, config, and a logger.
 * @returns a disposer that removes the listener and unwraps every engine it guarded.
 */
export function installGlobalGate({ ctx, policy, config, logger }) {
  /** Engines this listener wrapped, so a re-announcement cannot wrap one twice. */
  const owned = new Map()

  const onService = (name, value) => {
    if (name !== ENGINE_SERVICE) return
    // A disposal notification announces the name with no value: the instance goes
    // away with its realm, and nothing can call the method after that.
    if (value === null || value === undefined) return
    const engine = value[ORIGINAL] ?? value
    if (typeof engine.compactIfNeeded !== 'function') return
    if (owned.has(engine)) return
    const current = engine.compactIfNeeded
    if (typeof current === 'function' && current[GATE_MARK] !== undefined) return
    // The engine's own context resolves the pruner and the meter of ITS realm.
    const dispose = installGate({
      ctx: engine.ctx ?? ctx,
      engine,
      policy,
      config,
      logger,
      owner: 'host plane',
    })
    owned.set(engine, dispose)
    logger.info?.(`cache-guard: guarded a compaction engine of a preset realm `
      + `(${owned.size} in this process, mode ${config.mode})`)
  }

  const off = ctx.on('internal/service', onService, { global: true })
  return () => {
    off?.()
    for (const dispose of [...owned.values()]) dispose()
    owned.clear()
  }
}
