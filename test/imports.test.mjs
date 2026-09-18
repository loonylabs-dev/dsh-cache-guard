/**
 * Plugin contract tests: both halves load and export the function-plugin shape.
 *
 *   node test/imports.test.mjs
 *
 * The harness discards a function plugin's namespace when the module also has a
 * default export, so the absence of a default export is asserted here.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('plugin halves', () => {
  it('exports the host half as a function plugin', async () => {
    const host = await import('../index.js')
    assert.equal(host.name, 'dsh-cache-guard')
    assert.equal(typeof host.apply, 'function')
    assert.equal(host.default, undefined, 'a default export would drop the namespace')
  })

  it('exports the engine half with the services it wraps', async () => {
    const engine = await import('../engine.js')
    assert.equal(engine.name, 'dsh-cache-guard-engine')
    assert.equal(typeof engine.apply, 'function')
    assert.deepEqual(engine.inject, ['compaction', 'tokenMeter'])
    assert.equal(engine.default, undefined, 'a default export would drop the namespace')
  })

  it('imports nothing outside the package', async () => {
    const { readFileSync } = await import('node:fs')
    for (const file of ['../index.js', '../engine.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      const bare = [...source.matchAll(/from '([^'.][^']*)'/g)].map(match => match[1])
      assert.deepEqual(bare, [], `${file} must resolve every dependency from its own directory`)
    }
  })

  it('publishes the policy store under the cacheGuard service key', async () => {
    const { apply } = await import('../index.js')
    let provided
    const listeners = []
    const ctx = {
      provide: (key, value) => { provided = { key, value } },
      effect: callback => callback(),
      on: (name, listener, options) => { listeners.push({ name, options }); return () => {} },
      get: () => undefined,
      logger: undefined,
    }
    apply(ctx, { mode: 'auto', pricePerMTokens: 0.14 })
    assert.equal(provided.key, 'cacheGuard')
    assert.equal(provided.value.defaultMode, 'auto')
    assert.equal(provided.value.pricePerMTokens, 0.14)
    assert.equal(provided.value.mode('session-1'), 'auto')
    provided.value.setMode('session-1', 'manual')
    assert.equal(provided.value.mode('session-1'), 'manual')
    assert.equal(provided.value.engines(), 0, 'no engine has appeared yet')
    // The host half has to hear every realm's engine, which only a global
    // listener does: the event's scope filter drops everyone else.
    const global = listeners.filter(entry => entry.name === 'internal/service' && entry.options?.global === true)
    assert.equal(global.length, 1)
  })

  it('installs no gate at all when the mode is off', async () => {
    const { apply } = await import('../index.js')
    const listeners = []
    const ctx = {
      provide: () => {},
      effect: callback => callback(),
      on: (name, listener, options) => { listeners.push({ name, options }); return () => {} },
      get: () => undefined,
      logger: undefined,
    }
    apply(ctx, { mode: 'off' })
    const global = listeners.filter(entry => entry.options?.global === true)
    assert.deepEqual(global, [], 'off is the documented way out of the guard')
  })

  it('rejects an unknown mode loud', async () => {
    const { apply } = await import('../index.js')
    const ctx = { provide: () => {}, effect: callback => callback(), on: () => {}, get: () => undefined, logger: undefined }
    assert.throws(() => apply(ctx, { mode: 'sometimes' }), /unknown mode "sometimes"/)
    assert.throws(() => apply(ctx, { estimatedSummaryTokens: 0 }), /positive integer/)
  })
})
