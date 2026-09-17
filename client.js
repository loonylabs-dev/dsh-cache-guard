/**
 * dsh-cache-guard — browser half.
 *
 * Adds one entry to the composer dock (the row the context meter lives in): a
 * small pill that shows which mode the guard is in and, when the last automatic
 * rewrite was priced, what it cost. Clicking it offers the two modes; the host
 * half keeps the choice for the session.
 *
 * Loaded through the client module table, which is why the wrapper below and the
 * `dsh.client` manifest in package.json are both required.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cache-guard',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const React = require('react')

    const STYLE_ID = 'cg-styles'
    const POLL_MS = 4_000

    const STYLES = [
      '.cg-wrap { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }',
      '.cg-pill { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border: none; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; }',
      '.cg-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.cg-pill:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }',
      '.cg-pill.auto { color: var(--dsw-alias-state-warn-primary); }',
      '.cg-info { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 18ch; }',
      '.cg-readout { padding: 6px 9px 2px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: normal; }',
      '.cg-readout.dim { padding-top: 0; padding-bottom: 6px; color: var(--dsw-alias-label-tertiary); border-bottom: 1px solid var(--dsw-alias-border-l2); margin-bottom: 4px; }',
      '.cg-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 20; width: 250px; padding: 4px; border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3); background: var(--dsw-specific-menu); color: var(--dsw-alias-label-primary); }',
      '.cg-item { display: flex; flex-direction: column; gap: 2px; width: 100%; box-sizing: border-box; padding: 7px 9px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }',
      '.cg-item:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.cg-item.active .cg-item-label { color: var(--dsw-alias-state-business-primary); }',
      '.cg-item-label { font-size: 13px; font-weight: 500; line-height: 20px; }',
      '.cg-item-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }',
    ].join('\n')

    /** Inject the sheet once; the browser half owns its own styling. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }

    /** Render a token count the way the dialog reads it. */
    function formatTokens(tokens) {
      if (typeof tokens !== 'number') return '?'
      if (tokens < 1000) return String(Math.round(tokens))
      if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
      return `${(tokens / 1_000_000).toFixed(2)}M`
    }

    const MODE_OPTIONS = [
      {
        mode: 'manual',
        label: 'Ask before every rewrite',
        hint: 'Pruning and summarizing wait for your approval.',
      },
      {
        mode: 'auto',
        label: 'Allow automatically',
        hint: 'Runs without asking; its cost shows up here afterwards.',
      },
    ]

    /**
     * The sentence for the tooltip and the menu: what the last changing plan
     * would have cost, and what happened to it.
     * @param action - a `lastAction` record, or null.
     * @returns a human-readable line.
     */
    function describeAction(action) {
      if (action === null || action === undefined) return 'no automatic rewrite planned yet'
      const pruned = Array.isArray(action.pruned) ? action.pruned.length : 0
      const parts = []
      if (pruned > 0) parts.push(`${pruned} tool results pruned`)
      else if (action.summary !== null && action.summary !== undefined) parts.push('summarized')
      const cold = action.estimate === null || action.estimate === undefined ? 0 : action.estimate.coldTokens
      if (cold > 0) parts.push(`${formatTokens(cold)} re-read in full`)
      const tail = action.outcome === 'declined' ? ' (declined, nothing changed)' : ' (allowed)'
      return parts.length === 0 ? 'no rewrite needed' : `last rewrite: ${parts.join(' · ')}${tail}`
    }

    /** The live context line: how full the window is and where the guard would step in. */
    function describePressure(pressure) {
      if (pressure === null || pressure === undefined || typeof pressure.totalTokens !== 'number') return ''
      if (typeof pressure.contextWindow !== 'number') return `Context ${formatTokens(pressure.totalTokens)}`
      return `Context ${formatTokens(pressure.totalTokens)} of ${formatTokens(pressure.contextWindow)}`
        + (typeof pressure.thresholdTokens === 'number'
          ? ` · rewrite at ${formatTokens(pressure.thresholdTokens)}`
          : '')
    }

    /** Poll the host for this session's guard state. */
    function createFace(sessionId) {
      let state = null
      const listeners = new Set()
      const publish = next => {
        state = next
        for (const listener of [...listeners]) listener()
      }
      const url = `/cache-guard/state?session=${encodeURIComponent(sessionId)}`
      return {
        sessionId,
        snapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        refresh() {
          fetch(url, { headers: { accept: 'application/json' } })
            .then(response => response.ok ? response.json() : undefined)
            .then(payload => { if (payload !== undefined) publish(payload) })
            .catch(() => {})
        },
        setMode(mode) {
          return fetch('/cache-guard/mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, mode }),
          }).then(response => response.json()).then(publish).catch(() => {})
        },
      }
    }

    /** The composer tool-row entry: one mode pill; everything else lives in its menu. */
    function CacheGuardDock(props) {
      const face = props.face
      const [state, setState] = React.useState(face.snapshot())
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => face.subscribe(() => setState(face.snapshot())), [face])
      React.useEffect(() => {
        face.refresh()
        const timer = setInterval(() => face.refresh(), POLL_MS)
        return () => clearInterval(timer)
      }, [face])

      const mode = state === null ? null : state.mode
      const label = mode === 'auto' ? 'Cache: auto' : mode === null ? 'Cache: …' : 'Cache: ask'
      // `pressure`/`lastAction` are the current host payload; the `plan` fallback
      // keeps an older host half usable until the harness is restarted.
      const plan = state === null ? null : state.plan
      const livePressure = state === null ? null : (state.pressure ?? plan)
      const lastAction = state === null
        ? null
        : (state.lastAction ?? (plan !== null && plan !== undefined && plan.estimate !== null ? plan : null))
      const pressure = livePressure === null ? '' : describePressure(livePressure)
      const action = describeAction(lastAction)
      const children = [
        React.createElement('button', {
          key: 'pill',
          type: 'button',
          className: mode === 'auto' ? 'cg-pill auto' : 'cg-pill',
          title: `${mode === 'auto'
            ? 'Automatic context rewrites run without asking.'
            : 'Every automatic context rewrite waits for your approval.'}\n${pressure}\n${action}`,
          onClick: () => setOpen(!open),
        }, label),
      ]
      if (open) {
        children.unshift(React.createElement('div', { key: 'menu', className: 'cg-menu' },
          pressure === '' ? null : React.createElement('div', { className: 'cg-readout' }, pressure),
          React.createElement('div', { className: 'cg-readout dim' }, action),
          MODE_OPTIONS.map(option => React.createElement('button', {
            key: option.mode,
            type: 'button',
            className: mode === option.mode ? 'cg-item active' : 'cg-item',
            onClick: () => { setOpen(false); face.setMode(option.mode) },
          },
          React.createElement('span', { className: 'cg-item-label' }, option.label),
          React.createElement('span', { className: 'cg-item-hint' }, option.hint)))))
      }
      return React.createElement('div', { className: 'cg-wrap' }, children)
    }

    /**
     * Activation probe: loading the page with `?cg-selftest=1` marks a probe
     * session through the host endpoint, and the session id carries the outcome
     * so the host can be asked which one the plugin used. It separates "the
     * bundle never activated" from "the slots service was missing" from "the
     * dock entry renders somewhere unexpected".
     * @param outcome - `registered` or `noslots`.
     */
    function selfTest(outcome) {
      if (typeof location === 'undefined') return
      if (!new URLSearchParams(location.search).has('cg-selftest')) return
      fetch('/cache-guard/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: `__cg-selftest-${outcome}__`, mode: 'auto' }),
      }).catch(() => {})
      console.info(`[dsh-cache-guard] self-test: apply() ran, slot registration: ${outcome}`)
    }

    function apply(ctx) {
      let registered = false
      const register = () => {
        if (registered) return
        const slots = ctx.get('slots')
        if (slots === undefined) return
        registered = true
        ensureStyles()
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'cache-guard',
          order: 10,
          inject: (sessionId) => ({ face: createFace(sessionId) }),
        }, CacheGuardDock))
      }
      register()
      // The `inject` declaration should already hold activation back until the
      // `slots` service exists; retry through both channels anyway so an earlier
      // arrival cannot leave the dock silently empty.
      if (!registered) {
        if (typeof ctx.on === 'function') {
          ctx.on('internal/service', name => { if (name === 'slots') register() })
        }
        let attempts = 0
        const timer = setInterval(() => {
          register()
          attempts += 1
          if (registered || attempts > 40) clearInterval(timer)
        }, 250)
      }
      selfTest(registered ? 'registered' : 'noslots')
    }

    exports.name = 'dsh-cache-guard'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
