/**
 * Unit tests for the host endpoints and the browser half's load contract.
 *
 *   node test/routes.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyMode, registerCacheGuardRoutes, statePayload, writeJson } from '../lib/host-routes.js'
import { createPolicyStore } from '../lib/policy.js'

/** A response object that records what was written. */
function fakeResponse() {
  const written = {}
  return {
    written,
    statusCode: 0,
    setHeader(name, value) { written[name] = value },
    end(body) { written.body = body },
  }
}

/** Mount the routes against a fake web server and return the registered specs. */
function mounted(store, config = { mode: 'manual', estimatedSummaryTokens: 4000 }) {
  const routes = []
  const ctx = {
    get: name => name === 'webServer'
      ? { register: spec => { routes.push(spec); return () => {} } }
      : undefined,
    effect: callback => callback(),
    on: () => {},
  }
  registerCacheGuardRoutes({ ctx, store, config, logger: { warn: () => {} } })
  return routes
}

describe('statePayload', () => {
  it('reports the session mode, the default, and the last priced plan', () => {
    const store = createPolicyStore({ defaultMode: 'manual' })
    store.setMode('session-1', 'auto')
    store.recordEngines(3)
    store.recordPressure('session-1', { totalTokens: 839_046, contextWindow: 1_048_576, thresholdTokens: 838_860 })
    store.recordAction('session-1', { kind: 'prune-only', outcome: 'declined', estimate: { coldTokens: 724_447 } })
    const payload = statePayload({ store, config: { mode: 'manual', pricePerMTokens: 0.14 }, sessionId: 'session-1' })
    assert.deepEqual(payload, {
      sessionId: 'session-1',
      mode: 'auto',
      defaultMode: 'manual',
      pricePerMTokens: 0.14,
      engines: 3,
      pressure: { totalTokens: 839_046, contextWindow: 1_048_576, thresholdTokens: 838_860 },
      lastAction: { kind: 'prune-only', outcome: 'declined', estimate: { coldTokens: 724_447 } },
    })
  })

  it('answers a session the guard has never seen with the default mode', () => {
    const store = createPolicyStore({ defaultMode: 'auto' })
    const payload = statePayload({ store, config: { mode: 'auto' }, sessionId: 'fresh' })
    assert.equal(payload.mode, 'auto')
    assert.equal(payload.pressure, null)
    assert.equal(payload.lastAction, null)
    assert.equal(payload.pricePerMTokens, null)
    assert.equal(payload.engines, 0, 'no engine guarded yet: the client must be able to say so')
  })
})

describe('applyMode', () => {
  it('records the choice and rejects an unknown mode', () => {
    const store = createPolicyStore({ defaultMode: 'manual' })
    assert.equal(applyMode({ store, sessionId: 's', mode: 'auto' }), 'auto')
    assert.equal(store.mode('s'), 'auto')
    assert.equal(applyMode({ store, sessionId: 's', mode: 'off' }), 'off', 'off is the documented way out')
    assert.equal(store.mode('s'), 'off')
    assert.throws(() => applyMode({ store, sessionId: 's', mode: 'sometimes' }), /unknown mode/)
  })
})

describe('registerCacheGuardRoutes', () => {
  it('serves the state and accepts a mode change', async () => {
    const store = createPolicyStore({ defaultMode: 'manual' })
    const routes = mounted(store)
    assert.deepEqual(routes.map(route => route.path), ['/cache-guard/state', '/cache-guard/mode'])

    const stateRes = fakeResponse()
    routes[0].handler({ url: '/cache-guard/state?session=abc' }, stateRes)
    assert.equal(stateRes.statusCode, 200)
    assert.equal(JSON.parse(stateRes.written.body).mode, 'manual')

    const modeRes = fakeResponse()
    routes[1].handler(bodyRequest({ session: 'abc', mode: 'auto' }), modeRes)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(modeRes.statusCode, 200)
    assert.equal(JSON.parse(modeRes.written.body).mode, 'auto')
    assert.equal(store.mode('abc'), 'auto')
  })

  it('rejects a state request without a session and a bad mode body', async () => {
    const store = createPolicyStore({ defaultMode: 'manual' })
    const routes = mounted(store)
    const missing = fakeResponse()
    routes[0].handler({ url: '/cache-guard/state' }, missing)
    assert.equal(missing.statusCode, 400)

    const bad = fakeResponse()
    routes[1].handler(bodyRequest({ session: 'abc', mode: 'nope' }), bad)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(bad.statusCode, 400)
    assert.match(JSON.parse(bad.written.body).error, /unknown mode/)
  })

  it('retries the mount when the web server appears later', () => {
    const registered = []
    let webServer
    const ctx = {
      get: name => name === 'webServer' ? webServer : undefined,
      effect: callback => callback(),
      on: (event, listener) => { if (event === 'internal/service') deferred = listener },
    }
    let deferred
    registerCacheGuardRoutes({ ctx, store: createPolicyStore({}), config: {}, logger: { warn: () => {} } })
    assert.equal(registered.length, 0)
    webServer = { register: spec => { registered.push(spec); return () => {} } }
    deferred('webServer')
    assert.equal(registered.length, 2)
  })
})

/** A request object that yields one JSON body. */
function bodyRequest(body) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    async *[Symbol.asyncIterator]() { yield payload },
  }
}

describe('writeJson', () => {
  it('sets a JSON content type and no-store cache header', () => {
    const res = fakeResponse()
    writeJson(res, 201, { ok: true })
    assert.equal(res.statusCode, 201)
    assert.match(res.written['content-type'], /application\/json/)
    assert.equal(res.written['cache-control'], 'no-store')
    assert.equal(res.written.body, '{"ok":true}')
  })
})
