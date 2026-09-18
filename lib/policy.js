/**
 * Per-session guard policy.
 *
 * The state is process-local: a session-scoped "don't ask again" choice lasts
 * until the harness restarts, and a deployment-wide default belongs to the
 * plugin's `mode` config. A durable per-session record would need a session
 * event type this harness build knows, which an out-of-repo plugin cannot add.
 *
 * @module dsh-cache-guard/policy
 */

/**
 * Guard modes: `manual` asks before an automatic surface change, `auto` only
 * reports it, and `off` leaves the operation to the engine as shipped.
 */
export const MODES = ['manual', 'auto', 'off']

/**
 * Build the shared policy store.
 * @param options `{ defaultMode }` — the mode for a session with no explicit choice.
 * @returns the store: mode per session, the declined turn, and the last priced plan.
 */
export function createPolicyStore(options = {}) {
  const defaultMode = options.defaultMode ?? 'manual'
  if (!MODES.includes(defaultMode)) throw new Error(`dsh-cache-guard: unknown mode "${defaultMode}"`)
  /** @type {Map<string, { mode?: string, declinedTurn?: number, lastPlan?: object }>} */
  const sessions = new Map()
  /**
   * Compaction engines this process has guarded. Zero means the guard is inert
   * for every session, which is the state the browser half must not present as
   * "waiting for your approval".
   */
  let engines = 0

  const entry = sessionId => {
    let current = sessions.get(sessionId)
    if (current === undefined) {
      current = {}
      sessions.set(sessionId, current)
    }
    return current
  }

  return {
    /** Effective mode for one session. */
    mode(sessionId) {
      return sessions.get(sessionId)?.mode ?? defaultMode
    },
    /** Record an explicit mode choice for one session. */
    setMode(sessionId, mode) {
      if (!MODES.includes(mode)) throw new Error(`dsh-cache-guard: unknown mode "${mode}"`)
      entry(sessionId).mode = mode
    },
    /** Whether the human already declined an operation inside this turn. */
    declinedInTurn(sessionId, turn) {
      return sessions.get(sessionId)?.declinedTurn === turn
    },
    /** Remember that the human declined inside this turn, so the guard does not re-ask each step. */
    recordDecline(sessionId, turn) {
      entry(sessionId).declinedTurn = turn
    },
    /**
     * Keep the latest pressure reading, so a client can show how full the
     * window is before anything happens. It changes every step and is not an
     * action.
     */
    recordPressure(sessionId, pressure) {
      entry(sessionId).pressure = pressure
    },
    /** The latest pressure reading, or `undefined` before the first step. */
    pressure(sessionId) {
      return sessions.get(sessionId)?.pressure
    },
    /**
     * Keep the last plan that would have changed the surface, together with the
     * answer it got. A no-op plan never lands here, so the record survives the
     * quiet steps that follow it.
     */
    recordAction(sessionId, action) {
      entry(sessionId).lastAction = action
    },
    /** The last changing plan and its outcome, or `undefined`. */
    lastAction(sessionId) {
      return sessions.get(sessionId)?.lastAction
    },
    /** Every session the store knows about. */
    sessionIds() {
      return [...sessions.keys()]
    },
    /**
     * Record how many engines this process currently guards. Written from the
     * one place a gate is installed or removed, so the browser half reads the
     * live reach of the guard instead of assuming it.
     */
    recordEngines(count) {
      engines = count
    },
    /** Guarded engines in this process; `0` means an automatic rewrite asks nobody. */
    engines() {
      return engines
    },
  }
}
