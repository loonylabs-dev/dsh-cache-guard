# Changelog

Notable changes to `dsh-cache-guard`, newest first. A feature addition bumps the
minor (`0.x.0`); a fix, a documentation change, or a manifest change bumps the
patch (`0.0.x`).

## 0.4.0

### Added

- **`tools/verify-preset.mjs` composes a preset file through a real Loader and
  prints what it contains**: every row, the `compaction` group's children, and the
  config the engine row carries. Reading the file answers neither question a config
  change raises — whether the threshold actually reaches `compaction-basic`, and
  whether the engine row is still inside the group — and a preset that fails to
  compose fails at session start, not at boot. Rows mount as stubs, so the check
  needs no service, no model, and no running server. Used on 2026-09-18 to confirm
  that this machine's `cache-guard` and `studio` presets both carry
  `thresholdRatio: 0.9` on the engine row.

### Fixed

- **The mode menu no longer renders behind the middle column in the studio.** The
  open menu was `position: absolute` inside the composer dock, so it answered to
  the conversation column that holds that dock — and that column both clamps its
  own overflow while a session is active and forms its own stacking context. The
  studio's middle column painted over the menu and clipped it at the column's
  edge, which the user read as "the menu opens behind the middle part instead of
  on top". No `z-index` wins that: a clip is not a stacking question, and the
  column's own stacking index sits below the middle column's regardless. The menu
  now portals to `<body>` and is placed in viewport coordinates from the pill's
  own rect, so it floats above every column and stays on screen. The same fix
  `dsh-model-chooser` 0.1.2 made to its picker panel for the identical read.
  The placement and the portal are pinned in `test/client.test.mjs` (red against
  the shipped `position: absolute` bundle, green with this change).
- **The open menu now closes when you click outside it.** Before, it closed only
  by the pill/chevron or a menu row — clicking empty space beside it did nothing.
  The menu now sits over a transparent full-screen backdrop (portaled to
  `<body>`, `z-index` just under the menu) whose click closes the menu, the way
  the model chooser's panel behaves. A click on the menu itself still lands on it.
  Pinned in `test/client.test.mjs`.

## 0.3.0

### Fixed

- **The guard was opt-in, and the sessions that needed it most were the ones
  without it.** The engine that has to be wrapped is created inside an agent
  preset: the shipped `compaction` group isolates `compaction` and
  `toolResultPruner`, so the instance belongs to the preset's realm and a profile
  patch never reaches it. Mounting the engine as a preset row therefore guarded
  only the sessions composed on that preset, and the preset's reach is invisible
  from the outside — the session header names the preset it was *created* with,
  while `agent-preset/selected` records the one it actually runs.

  Measured on 2026-09-18, session `d44108e7` (web profile): created on `studio`,
  re-composed as `standard` when it was resumed, and the shipped `standard` preset
  carries no guard row. At 17:57:22 the engine ran its own prune-first pass — 13
  tool results replaced, 52,181 tokens priced as freed — and the next request
  re-read **781,264 tokens at full price**: 2.7% cached, $0.1176 against $0.0025
  for the requests around it. The threshold was `0.8` (the shipped default; the
  `0.9` set for the `studio` and `cache-guard` presets never applied here), and
  1,314 tokens were missing to it. Nothing asked, because nothing was guarding.

  The host half now guards every realm's engine itself. It listens on
  `internal/service` with `{ global: true }` — the event carries a scope filter
  that drops every listener outside the providing realm, and bypassing exactly
  that filter is the only way to hear a preset's registration from the host plane
  (the harness's own preset invariant uses the same seam). It wraps the instance
  behind the announced value (`Symbol.for('cordis.original')`, since the announced
  value is a traced read whose `ctx` answers with the *reading* context) and prices
  through that instance's own context, which resolves the realm's pruner and token
  meter. Installing the plugin is now the whole opt-in: every session is guarded,
  on every preset, including the shipped `standard`. The log says so
  (`dsh-cache-guard: guarded a compaction engine of a preset realm (1 in this
  process, mode manual)`).

- **The pill promised protection it could not back.** It read the host half's mode
  and nothing else, so `mode: manual` always rendered `Cache: ask` with the
  tooltip *"Every automatic context rewrite waits for your approval"* — including
  in the session above, where no gate existed and the rewrite landed unanswered.
  The host half now reports how many compaction engines it is guarding, and the
  pill reads that number: `Cache: not armed` when the answer is none, with a
  warning row in its menu that says rewrites run without asking. The state payload
  gains `engines`; an older host half that does not send it keeps the previous
  three labels instead of claiming a state it cannot know.

### Added

- **`off` is a third mode**, beside `manual` and `auto`: the operation stays with
  the engine and nothing is priced, asked, or blocked. It is the documented way
  out per session (a menu row in the pill) or per deployment (the config value
  `mode: off`, which also skips installing the gate at all).

### Changed

- **A pricing failure hands the operation back to the engine instead of declining
  it.** The wrapper used to answer `null` — "nothing to compact" — when its own
  pricing threw, which was indistinguishable from a human's no and would have
  stopped compaction in every session the guard covers. That is the opposite of
  this plugin's own rule: a guard bug may cost money, it may never strand a
  session. Declining is now reserved for the guard's actual decisions (a no, no
  answerer, nothing to decide); an unpriceable operation goes back to the engine
  and the log says why.
- **An engine is wrapped at most once per process, and the marker lives on the
  wrapper function** (`Symbol.for('dsh-cache-guard.gate')`) rather than on the
  instance: a traced service read hands back a fresh proxy for the same method on
  every read, so comparing the stored method with the wrapper it replaced never
  matched, and a disposer could neither recognize nor restore its own work. A
  preset row that arrives after the host plane now reports
  `already guarded by the host plane` and stays inert, even when the two halves
  are separate installed copies of this package.
- The host row's configuration governs where both halves are mounted; a preset
  row's config applies only to a deployment that has no host half.

## 0.2.0

### Changed

- **Pruning and summarizing are one operation, and the guard owns it.** The
  engine's own pass tries the model-free phase first and summarizes only if the
  surface is still too large, which pays badly: pruning rewrites in place, so the
  surface stays almost as large (measured: 839k → 737k) and the next request pays
  the cache break at nearly full size — 720,764 tokens re-read cold for a pass that
  freed 93k and needed 186. The guard now plans both phases and runs the engine's
  public `compactRegion` **first**, then the pruner: the checkpoint lands at the
  oldest replaced position, every pruning rewrite after it sits behind that break,
  and the provider's cache is broken once instead of twice. The same session,
  priced with the span the guard replaces, comes to 255k cold. A declined plan
  returns `null` for the whole operation, so a prune-only pass can no longer land
  behind a checkpoint that never was.
- The generator keeps the guarded preset **opt-in** as the machine-wide default:
  `agent-presets.default` layers over a profile's own composition default, so
  writing it silently would move every other profile of that harness home onto
  this preset. `--set-default` writes it deliberately, `--remove-default` takes it
  back.

### Added

- **The session simulation prices the newest-end alternative beside the plan the
  engine took**, so a measurement of a real rewrite shows what pruning from the
  oldest candidate cost against pruning from the end the surface actually needs
  (`rewrites 2 of 13`, `predicted cold 438,772` in the measured session).

### Fixed

- **The client's stylesheet is refreshed by content, not by presence.** The
  client-plugin HMR receiver re-runs `apply()` in the same document, so a
  presence-only guard paired new markup with the stylesheet of the bundle it had
  replaced.
- The pill and its menu were given the composer's own anatomy — 28px pill, leading
  design-system glyph, rotating chevron, and menu rows with a leading glyph and a
  trailing check for the selection, as the neighbouring menus have. The label
  collapses to glyph and chevron in a narrow composer.

## 0.1.0

### Added

- First release. The guard sits in front of the two automatic rewrites of the
  model-visible surface — tool-result pruning and summarization — prices them
  before anything is touched, and asks. Both entry points are covered by wrapping
  the one instance method the engine itself calls (`compactIfNeeded`), which is
  what the step-pressure path and the provider-overflow recovery path share.
- The dialog carries the numbers that decide it: the window and the trigger, how
  many tool results go, how many tokens that frees, the size of the checkpoint
  that replaces the span, and how many tokens break the cache at which surface
  position — as a share of the request and, with `pricePerMTokens`, in currency.
- The pill in the composer's tool row, its mode menu, and the two loopback
  endpoints (`GET /cache-guard/state`, `POST /cache-guard/mode`) behind them.
- Fail closed on silence: with `manual` and no question provider registered, the
  automatic rewrite is declined and the log names the way out.
- `tools/install-profile.mjs` for a deployment that mounts the engine as a preset
  row, and `tools/simulate-session.mjs` to price a real session log's first
  automatic rewrite — the measurement the pricing is calibrated against.
