/**
 * Host endpoints for the browser half.
 *
 *   GET  /cache-guard/state?session=<id>  -> mode, default mode, price, last plan
 *   POST /cache-guard/mode                -> { session, mode } and the same state
 *
 * The routes are registered lazily: a profile without a web stack never provides
 * `webServer`, and a hard injection would park this fiber forever. `internal/service`
 * fires whenever any service appears, so the mount retries until it lands once.
 *
 * @module dsh-cache-guard/host-routes
 */
import { MODES } from './policy.js'

/** Send one JSON response. */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.setHeader?.('cache-control', 'no-store')
  res.end(payload)
}

/**
 * The state a session's client reads.
 * @param input the store, the resolved config, and the session id.
 * @returns the payload served to the browser.
 */
export function statePayload({ store, config, sessionId }) {
  return {
    sessionId,
    mode: store.mode(sessionId),
    defaultMode: config.mode,
    pricePerMTokens: config.pricePerMTokens ?? null,
    /** Latest pressure reading; changes every step. */
    pressure: store.pressure(sessionId) ?? null,
    /** Last plan that would have changed the surface, with the answer it got. */
    lastAction: store.lastAction(sessionId) ?? null,
  }
}

/**
 * Apply one mode choice for a session.
 * @param input the store, the session id, and the requested mode.
 * @returns the validated mode.
 * @throws when the requested mode is unknown.
 */
export function applyMode({ store, sessionId, mode }) {
  if (!MODES.includes(mode)) {
    throw new Error(`dsh-cache-guard: unknown mode "${mode}" (expected ${MODES.join(' | ')})`)
  }
  store.setMode(sessionId, mode)
  return mode
}

/** Read and parse a JSON request body, bounded to a small size. */
async function readJson(req, limit = 4_096) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * Register the cache-guard routes on the web server, retrying until it exists.
 * @param input the host context, the shared policy store, the resolved config, and a logger.
 * @returns a disposer that removes the pending retry listener.
 */
export function registerCacheGuardRoutes({ ctx, store, config, logger }) {
  let mounted = false
  const mount = () => {
    if (mounted) return
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    mounted = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/cache-guard/state',
      handler: (req, res) => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1')
        const sessionId = url.searchParams.get('session')
        if (sessionId === null || sessionId === '') return writeJson(res, 400, { error: 'missing session' })
        writeJson(res, 200, statePayload({ store, config, sessionId }))
      },
    }), 'cache-guard: /cache-guard/state route')
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/cache-guard/mode',
      handler: (req, res) => {
        readJson(req).then(body => {
          const sessionId = typeof body.session === 'string' ? body.session : ''
          if (sessionId === '') return writeJson(res, 400, { error: 'missing session' })
          applyMode({ store, sessionId, mode: body.mode })
          writeJson(res, 200, statePayload({ store, config, sessionId }))
        }).catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn?.(`dsh-cache-guard: mode request rejected: ${message}`)
          writeJson(res, 400, { error: message })
        })
      },
    }), 'cache-guard: /cache-guard/mode route')
  }
  mount()
  ctx.on('internal/service', name => {
    if (name === 'webServer') mount()
  })
  return () => {}
}
