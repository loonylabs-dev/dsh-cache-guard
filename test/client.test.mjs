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
      if (specifier === 'react' || specifier === 'react-dom') return fakeReact
      throw new Error('unexpected require: ' + specifier)
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

  it('refreshes its sheet instead of trusting an older bundle\'s element', () => {
    // The client-plugin HMR receiver re-runs apply() in the same document, so a
    // presence-only guard pairs new markup with the replaced bundle's stylesheet.
    const plugin = captured[0].factory(() => fakeReact)
    const existing = { id: 'cg-styles', textContent: 'stale sheet' }
    const created = []
    globalThis.document = {
      getElementById: id => (id === 'cg-styles' ? existing : null),
      createElement: () => { const node = { textContent: '' }; created.push(node); return node },
      head: { appendChild: () => {} },
    }
    try {
      plugin.apply({
        get: () => ({ inject: (_slot, callback) => callback(), register: () => () => {} }),
      })
      assert.equal(created.length, 0, 'the existing sheet must be reused, never duplicated')
      assert.notEqual(existing.textContent, 'stale sheet')
      assert.match(existing.textContent, /\.cg-item \{ display: flex; align-items: flex-start/)
      assert.match(existing.textContent, /\.cg-item-check \{/)
    } finally {
      delete globalThis.document
    }
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

  it('floats the menu out of the composer through a <body> portal', () => {
    // The studio bug: the menu was `position: absolute` inside the composer
    // dock, so the conversation column both clipped it and lost the stacking race
    // to the middle column — the user read it as "the menu is behind the preview".
    // The same fix dsh-model-chooser 0.1.2 made to its picker panel. A clip is
    // not a stacking question, so no z-index wins it; the menu must leave the
    // composer's subtree for <body> and be placed in viewport coordinates.
    assert.match(source, /ReactDOM\.createPortal\(el, document\.body\)/,
      'the menu must portal to <body>')
    assert.match(source, /\.cg-menu \{ position: fixed/,
      'the menu must be position: fixed, never absolute inside the column')
    assert.doesNotMatch(source, /\.cg-menu \{ position: absolute/,
      'the menu must not stay absolutely positioned in the composer subtree')
    assert.match(source, /portalOrInline\(React\.createElement\('div', \{[\s\S]*?className: 'cg-menu'/,
      'the menu element is rendered through the portal helper')
    assert.match(source, /measureMenuStyle\(pillRef\.current\)/,
      'the menu is placed in viewport coordinates from the pill\'s own rect')
    assert.match(source, /useLayoutEffect[\s\S]*?'resize'[\s\S]*?'scroll'/,
      'the menu re-measures when the window or conversation moves under it')
  })

  it('closes the menu when a click lands outside it (the chooser backdrop)', () => {
    // Without a catch layer the menu only closed via the pill/chevron or a menu
    // item; clicking empty space did nothing. The model chooser solves this with a
    // full-screen transparent backdrop under the menu; the guard mirrors it.
    assert.match(source, /\.cg-backdrop \{ position: fixed; inset: 0/,
      'a full-screen backdrop layer must exist')
    assert.match(source, /className: 'cg-backdrop'[\s\S]*?onClick: \(\) => setOpen\(false\)/,
      'a click on the backdrop closes the menu')
    assert.match(source, /portalOrInline\(React\.createElement\('button', \{[\s\S]*?className: 'cg-backdrop'/,
      'the backdrop is portaled to <body> with the menu, so a neighbouring column cannot out-click it')
  })

  it('tells protection apart from the absence of it', () => {
    // The pill promised "every automatic rewrite waits for your approval" in a
    // session that had no guarded engine at all. It now reads the host's reach
    // and says so instead.
    assert.match(source, /state\.engines/, 'the pill must read how many engines are guarded')
    assert.match(source, /Cache: not armed/)
    assert.match(source, /No guarded compaction engine in this process/)
    assert.match(source, /mode: 'off'/, 'and it must offer the way out')
  })
})
