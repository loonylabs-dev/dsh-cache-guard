/**
 * Load-contract tests for the browser half.
 *
 *   node test/client.test.mjs
 *
 * The browser half is served as a static bundle, so its wrapper, its exports, and
 * the slot registration it performs are the only things an automated test can
 * check without a browser.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

/** Minimal React stand-in; the component is never rendered here. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
}

const captured = []
globalThis.window = { __ModuleLoader__: { load: config => captured.push(config) } }
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
await import('../client.js')

describe('browser half', () => {
  it('registers itself through the client module loader', () => {
    assert.equal(captured.length, 1)
    assert.equal(captured[0].id, 'dsh-cache-guard')
    assert.equal(typeof captured[0].factory, 'function')
  })

  it('exports the function-plugin shape the loader expects', () => {
    const plugin = captured[0].factory(specifier => {
      assert.equal(specifier, 'react')
      return fakeReact
    })
    assert.equal(plugin.name, 'dsh-cache-guard')
    assert.deepEqual(plugin.inject, ['slots'])
    assert.equal(typeof plugin.apply, 'function')
  })

  it('adds one entry to the composer tool row and nothing else', () => {
    const plugin = captured[0].factory(() => fakeReact)
    const registrations = []
    const injects = []
    plugin.apply({
      get: name => name === 'slots'
        ? {
            inject: (slot, callback) => { injects.push(slot); callback() },
            register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
          }
        : undefined,
    })
    assert.deepEqual(injects, ['conversation.input.left'])
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].spec.name, 'conversation.input.left')
    assert.equal(registrations[0].spec.id, 'cache-guard')
    assert.equal(typeof registrations[0].spec.inject, 'function')
    assert.equal(typeof registrations[0].component, 'function')
    const injected = registrations[0].spec.inject('session-1')
    assert.equal(injected.face.sessionId, 'session-1')
    assert.equal(typeof injected.face.refresh, 'function')
  })

  it('does nothing when the slot service is absent', () => {
    const plugin = captured[0].factory(() => fakeReact)
    plugin.apply({ get: () => undefined })
    assert.equal(captured.length, 1)
  })

  it('reads the session id from its own request and never a hardcoded one', () => {
    assert.match(source, /\/cache-guard\/state\?session=/)
    assert.match(source, /\/cache-guard\/mode/)
  })
})
