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

    /**
     * Glyphs inlined from the harness design system
     * (`dsh-client-ui-primitives/src/icons`), because the browser half imports no
     * package: a chip that carries no icon reads as plain text in the composer row.
     */
    const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z'
    /** `ic_ds_question_outline_14`: the guard is waiting for an answer. */
    const QUESTION_PATHS = [
      'M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z',
      'M6.18042 8.68184C6.18043 8.09153 6.32893 7.34655 6.92127 6.8481C7.28566 6.54148 7.76104 6.27318 8.0022 6.10811C8.28964 5.91137 8.42234 5.76562 8.48328 5.58944C8.57774 5.31609 8.53121 5.00904 8.34912 4.76741C8.17409 4.53522 7.83879 4.32222 7.28186 4.32222C5.99668 4.32225 5.46969 5.11832 5.46949 5.78939H4.24414C4.24436 4.39942 5.36327 3.09691 7.28186 3.09688C8.17773 3.09688 8.89489 3.45606 9.32752 4.02999C9.75287 4.59438 9.86938 5.32775 9.64026 5.99019C9.44847 6.5444 9.04722 6.87743 8.69434 7.11898C8.29506 7.39226 8.02318 7.52192 7.70996 7.78548C7.51943 7.94582 7.40577 8.24899 7.40577 8.68184V8.75533H6.18042V8.68184Z',
      'M7.39455 9.44026V10.8109H6.16921V9.44026H7.39455Z',
    ]
    /** `ic_ds_check_outline_14`: the guard runs unprompted. */
    const CHECK_PATH = 'M11.5635 4.58984L7.61426 9.07715C7.35154 9.37561 7.11346 9.64812 6.89453 9.84668C6.66593 10.054 6.38519 10.2506 6.01465 10.3164C5.82079 10.3508 5.62207 10.3529 5.42773 10.3213C5.0561 10.2609 4.77266 10.0674 4.54102 9.86328C4.31926 9.66791 4.07752 9.39911 3.81055 9.10449L2.44531 7.59863L3.55664 6.59082L4.92188 8.09766C5.21256 8.41844 5.38878 8.61191 5.53223 8.73828C5.61022 8.80699 5.65253 8.83192 5.66895 8.83984C5.69648 8.84429 5.72449 8.84467 5.75195 8.83984C5.72657 8.84451 5.75564 8.85422 5.88672 8.73535C6.02833 8.60692 6.20225 8.41088 6.48828 8.08594L10.4385 3.59961L11.5635 4.58984Z'

    /**
     * One design-system glyph.
     * @param paths - SVG path data.
     * @param size - pixel size; the trigger renders 14px, menu rows keep the native 16px.
     */
    function glyph(paths, size = 14) {
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 14 14',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
      }, paths.map((d, index) => React.createElement('path', { key: index, d, fill: 'currentColor' })))
    }

    const STYLES = [
      // Geometry mirrors the composer's own mode chip
      // (dsh-client-ui-conversation skeleton/PermissionSelect.module.css) so the
      // guard reads as one of the row's controls instead of loose text.
      '.cg-wrap { position: relative; display: inline-flex; align-items: center; gap: 6px; min-width: 0; }',
      '.cg-pill { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 220px; height: 28px; padding: 0 4px 0 8px; border: none; border-radius: 24px; outline: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 13px; font-weight: 500; line-height: 20px; }',
      '.cg-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.cg-pill:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }',
      '.cg-pill.auto { color: var(--dsw-alias-state-warn-primary); }',
      '.cg-icon { display: inline-flex; flex: 0 0 auto; }',
      '.cg-icon svg { width: 14px; height: 14px; }',
      '.cg-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.cg-chevron { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }',
      '.cg-chevron.open { transform: rotate(180deg); }',
      // Narrow composer: the label yields to icon + chevron, as the sibling chips do.
      '@container (max-width: 460px) { .cg-pill .cg-label { display: none; } }',
      '.cg-info { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 18ch; }',
      '.cg-readout { padding: 6px 9px 2px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: normal; }',
      '.cg-readout.dim { padding-top: 0; padding-bottom: 6px; color: var(--dsw-alias-label-tertiary); border-bottom: 1px solid var(--dsw-alias-border-l2); margin-bottom: 4px; }',
      '.cg-menu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 20; width: 264px; padding: 4px; border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3); background: var(--dsw-specific-menu); color: var(--dsw-alias-label-primary); }',
      // Rows follow the harness Menu: 8px gap between leading glyph, label, and a
      // trailing check for the selection — the selection is never a color fill.
      '.cg-item { display: flex; align-items: flex-start; gap: 8px; width: 100%; box-sizing: border-box; padding: 8px 10px; border: none; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 20px; text-align: left; cursor: pointer; }',
      '.cg-item:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '.cg-item-icon { display: inline-flex; flex: 0 0 auto; padding-top: 2px; color: var(--dsw-alias-label-tertiary); }',
      '.cg-item-icon svg { width: 16px; height: 16px; }',
      '.cg-item-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }',
      '.cg-item-label { font-weight: 500; }',
      '.cg-item-hint { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); white-space: normal; }',
      '.cg-item-check { display: inline-flex; flex: 0 0 auto; margin-left: auto; padding-top: 2px; color: var(--dsw-alias-label-primary); }',
      '.cg-item-check svg { width: 16px; height: 16px; }',
    ].join('\n')

    /**
     * Install the sheet, or refresh it when this bundle is a hot replacement of
     * an older one. Presence alone is not enough: the client-plugin HMR receiver
     * re-runs `apply` in the same document, so a presence-only guard would pair
     * new markup with the stylesheet of the bundle it replaced.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      let tag = document.getElementById(STYLE_ID)
      if (tag === null) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        document.head.appendChild(tag)
      }
      if (tag.textContent !== STYLES) tag.textContent = STYLES
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
          'aria-label': `${label} — ${action}`,
          'aria-expanded': open,
          'aria-haspopup': 'menu',
          title: `${mode === 'auto'
            ? 'Automatic context rewrites run without asking.'
            : 'Every automatic context rewrite waits for your approval.'}\n${pressure}\n${action}`,
          onClick: () => setOpen(!open),
        },
        React.createElement('span', { key: 'icon', className: 'cg-icon', 'aria-hidden': true },
          glyph(mode === 'auto' ? [CHECK_PATH] : QUESTION_PATHS)),
        React.createElement('span', { key: 'label', className: 'cg-label' }, label),
        React.createElement('span', {
          key: 'chevron',
          className: open ? 'cg-chevron open' : 'cg-chevron',
          'aria-hidden': true,
        }, glyph([CHEVRON_PATH]))),
      ]
      if (open) {
        children.unshift(React.createElement('div', { key: 'menu', className: 'cg-menu', role: 'menu' },
          pressure === '' ? null : React.createElement('div', { className: 'cg-readout' }, pressure),
          React.createElement('div', { className: 'cg-readout dim' }, action),
          MODE_OPTIONS.map(option => {
            const selected = mode === option.mode
            return React.createElement('button', {
              key: option.mode,
              type: 'button',
              role: 'menuitem',
              className: 'cg-item',
              'aria-checked': selected,
              onClick: () => { setOpen(false); face.setMode(option.mode) },
            },
            React.createElement('span', { className: 'cg-item-icon', 'aria-hidden': true },
              glyph(option.mode === 'auto' ? [CHECK_PATH] : QUESTION_PATHS, 16)),
            React.createElement('span', { className: 'cg-item-text' },
              React.createElement('span', { className: 'cg-item-label' }, option.label),
              React.createElement('span', { className: 'cg-item-hint' }, option.hint)),
            selected
              ? React.createElement('span', { className: 'cg-item-check', 'aria-hidden': true }, glyph([CHECK_PATH], 16))
              : null)
          })))
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
      // The `inject` declaration should already hold activation back until `slots`
      // exists. The fallback retries are deliberately short: they only cover an
      // earlier arrival, and a long timer would keep the page's module alive for
      // no benefit (and hold a Node test process open).
      if (!registered) {
        if (typeof ctx.on === 'function') {
          ctx.on('internal/service', name => { if (name === 'slots') register() })
        }
        let attempts = 0
        const timer = setInterval(() => {
          register()
          attempts += 1
          if (registered || attempts >= 5) clearInterval(timer)
        }, 200)
      }
      selfTest(registered ? 'registered' : 'noslots')
    }

    exports.name = 'dsh-cache-guard'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
