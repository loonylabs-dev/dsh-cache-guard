<div align="center">

# 🧊 dsh-cache-guard

*Host- and agent-layer DeepSeek Harness (DSH) plugin that prices every automatic context rewrite before it lands, asks the human by default, and reports what the provider had to re-read cold.*

<!-- Horizontal Badge Navigation Bar -->
[![npm version](https://img.shields.io/npm/v/dsh-cache-guard.svg?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-cache-guard)
[![CI](https://github.com/loonylabs-dev/dsh-cache-guard/actions/workflows/tests.yml/badge.svg?branch=master&style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/loonylabs-dev/dsh-cache-guard/actions)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge&logo=opensource&logoColor=white)](#license)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/loonylabs-dev/dsh-cache-guard)

</div>

<!-- Table of Contents -->
<details>
<summary>📋 <strong>Table of Contents</strong></summary>

- [What It Prevents](#what-it-prevents)
- [What It Shows](#what-it-shows)
- [Where It Is Active](#where-it-is-active)
- [How It Intercepts](#how-it-intercepts)
- [Guarantees](#guarantees)
- [Installation](#installation)
- [Profiles](#profiles)
- [Configuration](#configuration)
- [Verification & Testing](#verification--testing)
- [Known Limitations](#known-limitations)
- [🤝 Contributing](#-contributing)
- [🔗 Links](#-links)
- [License](#license)

</details>

---

## What It Prevents

A provider reuses its cached request prefix only up to the last unchanged token. Two automatic operations rewrite the model-visible surface, and both therefore re-bill the retained context at full price — without anyone being asked:

| Operation | What it rewrites | Why it is expensive |
|---|---|---|
| **Tool-result pruning** (`dsh-compaction-tool-result-pruner`) | Oversized tool results, in place | It starts at the **oldest** candidate, so everything after it becomes a cache miss |
| **Summarization** (`dsh-compaction-basic`) | An older span, replaced by one checkpoint | The checkpoint invalidates from the replaced position, and the summary itself is a full-prefix model call |

Measured on a real session (`deepseek-v4.1-flash`, 1M window): the pruner rewrote 28 tool results at once, freed 93k tokens, and the very next request re-read **720,764 tokens at full price** instead of 16,768 — $0.11 for one request, three steps before that session ended.

`dsh-cache-guard` sits in front of both operations, prices them first, and asks.

## What It Shows

A dialog before the change, with the numbers that decide it:

```
Context rewrite
An automatic context rewrite is ready. Allow it?
  Context: 839k of 1.05M (rewrite at 839k)
  Prunes 28 old tool results: 93k freed
  Then summarizes: ~4k checkpoint (estimated) instead of 746k
  Breaks the cache at position 0: 255k re-read in full (95% of the request)
  [ Allow once ]  [ Not now ]  [ Always allow (this session) ]
```

And a chip in the composer's tool row — inside the input card, right after the access-mode chip, built with the same geometry as its siblings (28px pill, design-system glyph, chevron that rotates while open). It carries the state; clicking it opens a small menu with the numbers. The label has four values: `Cache: ask`, `Cache: auto`, `Cache: off`, and `Cache: not armed` — the last one for a process where no compaction engine is being guarded, which is the state that let a rewrite break a cache unanswered. The glyph follows the mode — a question mark while the guard asks, a check while it runs unprompted or is off — and the label collapses to glyph + chevron in a narrow composer, exactly as the neighbouring chips do.

```
[ (?) Cache: ask ⌄ ]    ╭────────────────────────────────────────────╮
                        │ Context 837k of 1.05M · rewrite at 839k    │
                        │ last rewrite: 28 tool results pruned ·     │
                        │ 724k re-read in full (declined, nothing    │
                        │ changed)                                   │
                        │ ────────────────────────────────────────── │
                        │ (?) Ask before every rewrite           ✓   │
                        │     Pruning and summarizing wait for your  │
                        │     approval.                              │
                        │ (✓) Allow automatically                    │
                        │     Runs without asking; its cost shows up │
                        │     here afterwards.                       │
                        │ (✓) Guard off                              │
                        │     The engine compacts as shipped:        │
                        │     nothing is priced, asked, or blocked.  │
                        ╰────────────────────────────────────────────╯
```

Its menu rows follow the harness `Menu`: a leading 16px glyph, the label with its hint, and a trailing check for the selected row — the selection is a check, never a colour fill, exactly as in the neighbouring menus.

The long sentence also sits in the chip's tooltip, so hovering shows it without opening the menu. The host keeps the chosen mode per session.

## Where It Is Active

Installing the plugin is the whole opt-in: the host half guards **every** session, on every preset, with nothing to pick.

| Part | Lives in | Reach |
|---|---|---|
| host half | the profile bundle | **every** session: the gate on each preset realm's engine, the pill, its menu, and the mode endpoints |
| engine half (optional) | an agent preset, inside the `compaction` group | that preset only — a fallback for a deployment whose profile cannot carry the host half |

An agent's engine is created inside its preset: the shipped `compaction` group isolates `compaction` and `toolResultPruner`, so the profile's own layer cannot reach the instance. A plain `internal/service` listener does not hear the registration either — the event carries a scope filter that drops every listener outside the providing realm. The host half listens with `{ global: true }`, which bypasses exactly that filter, and wraps each engine the moment its realm announces it. That is the same seam the harness's own preset invariant uses to observe realm registrations.

Because the gate is armed from the host plane, a session composed on the shipped `standard` preset — the case that produced the measurement in [What It Prevents](#what-it-prevents) — is guarded like any other. Opting out is explicit, in three sizes: the session mode `off` in the pill, `mode: off` as a profile's or preset's configuration default, and removing the bundle.

## How It Intercepts

Both operations run through **one** method — `compactIfNeeded` on the live compaction engine. Pruning is the first phase inside that call, summarization the second, and the provider-overflow recovery path enters the same method. `compaction-basic` registers its listeners with `this` bound to the engine instance and calls `this.compactIfNeeded(...)` internally, so replacing that one instance method intercepts both paths. Wrapping the `compaction` service would not, and neither would a listener that only sees the host plane's services.

The announced value is a traced read, so its `ctx` answers with the *reading* context. The gate therefore takes the instance behind it (cordis exposes it under the global-registry symbol `cordis.original`) and prices through that instance's own context, which resolves the realm's pruner and meter. Pricing through the host plane would plan no pruning at all and understate the cold re-read.

The guard therefore:

1. prices the pending plan **before** anything is touched — which tool results are over the pruner's budget (the real pruner's own `pruneContent` decides, without mutating), which span a summarization would replace, and how many tokens break the cache at which surface position;
2. asks (manual mode) or reports (auto mode);
3. runs the operation itself on accept: the engine's public `compactRegion` transaction **first**, then the pruner. On decline — or when there is nothing to decide — it returns `null`, which the engine reads as *nothing to compact*.

**The guard never calls the original method.** That is what keeps the engine from running its own two-phase pass behind the guard's back, and it is why the phases can be paired: the checkpoint lands at the oldest replaced position, so every pruning rewrite that follows sits behind that cache break and adds nothing to it. The reverse order would pay the break twice whenever the summary lands anyway, and would leave a pruned surface behind if the range were rejected. The engine's transaction is atomic, so a rejected range throws before anything is written.

Nothing is imported from the compaction packages and no engine code is changed: the guard reads the engine's public config, calls its public `compactRegion`, and restores the original method when it unloads. Everything the harness owns around the operation — the transaction, the event lifecycle, the persistence, and the retry accounting in the calling listeners — stays the harness's.

### Pruning and summarizing are one operation

The engine's own pass tries the model-free phase first and summarizes only if the surface is still too large. A pass that stops there has a bad price: pruning rewrites in place, so the surface stays almost as large (measured: 839k → 737k) and the next request pays the cache break at nearly full size — 720,764 tokens re-read cold, for a pass that freed 93k and needed 186.

The guard always plans both. The same session, priced with the span the guard would replace, comes to **255k** cold: the surface drops to the retention tail plus a checkpoint, and the cache break is paid once.

## Guarantees

- **A guard bug never blocks the engine.** If pricing throws, the original call runs and the failure is logged. A guard that cannot price an operation must not decide it: treating its own failure as a decline would silently stop compaction in every session it guards.
- **The pill never promises protection the host cannot back.** It reads how many engines the process actually guards; with none, it says `Cache: not armed` instead of "waiting for your approval".
- **Fail closed on silence.** With the mode set to `manual` and no question provider registered, the automatic rewrite is declined and the log says how to allow it (`mode: auto`).
- **No repeat nagging.** A decline mutes the guard for the rest of the current turn instead of asking at every step.
- **One wrapper per engine, whoever gets there first.** The host half marks the wrapper function through a global-registry symbol, so a preset row arriving second recognizes the work and stays inert, even when the two halves are separate copies of this package.
- **No new session event types.** The bundle adds no `SessionEventMap` member: an event type this build does not know would make the session log unreadable to the very build that wrote it. The client surface derives everything from existing events and the guard's own state.
- **Zero runtime dependencies.** The package imports nothing outside itself, so it cannot bind to a second copy of a harness class. It reads two global-registry symbols (`cordis.original`) instead of importing cordis.

## Installation

```bash
dsh plugin --profile web add file:C:/path/to/plugins/dsh-cache-guard
```

That is the whole installation: the bundle patch mounts the host half, and the host half guards every preset realm's engine. The log shows `dsh-cache-guard: guarded a compaction engine of a preset realm (1 in this process, mode manual)` as soon as a session's realm appears, and `dsh-cache-guard: host ready (default mode manual)` at startup.

A preset row is only needed where the host half cannot be installed — a deployment that composes its profile without bundle patches. It must sit **inside the preset's `compaction` group**, because that group isolates the `compaction` and `toolResultPruner` services. The installer writes a preset that **includes the shipped composition and patches that one row in**:

```bash
node tools/install-profile.mjs --profile web --preset cache-guard
```

```yaml
# ~/.dsh/.agent-presets/cache-guard/agent.cordis.yml
- id: base
  name: 'cordis:include'
  config:
    path: 'file:///<dsh>/config/agent-presets/standard/agent.cordis.yml'
    patches:
      - id: compaction
        insert:
          - id: cache-guard
            name: 'file:///<you>/.dsh/profiles/web/node_modules/dsh-cache-guard/engine.js'
            config:
              mode: manual
```

`cordis:include` applies `patches` to the entries it reads, and an `insert` patch carrying an `id` pushes its rows into that group's child list. The preset is therefore **the shipped composition plus one row**, not a copy: a harness update to the shipped preset applies here too. The same file shape works for `code`, `cordis`, or a preset of your own — change `--source`.

A preset is chosen when a session starts, so a running session keeps the composition it began with — which is why the host half, not a preset row, is what makes the guard cover every session. When a row is used, its log line is `dsh-cache-guard: engine guarded (mode manual)`, and in a profile that also carries the host half the row reports `already guarded by the host plane`.

## Profiles

The preset roots and the settings document belong to the **harness home**, not to one profile, so:

- The host half guards every session of the profile it is installed in — one install per profile, and that profile needs no preset.
- A preset row, when used, is available to **every profile** on that machine: the engine half is self-contained (it resolves every dependency from its own directory), so one installed copy serves all of them.
- The **pill and its mode menu need the host half in that profile**. Without it nothing on screen can switch modes — and without it, nothing guards anything either.
- `--set-default` writes the machine-wide `agent-presets.default`. It is only meaningful for a row-based installation; with the host half installed, sessions are already guarded whatever preset they run, so leave the profile's own default alone.
- A profile **without a question provider** (headless, automation) has nothing to ask: in `manual` mode the guard then declines every automatic rewrite, and the session eventually hits its window. Set `mode: auto` for such a profile's host row (`cordis.patch.yml`) or turn the guard `off` there.

For plugin development, install it as a link so edits apply without reinstalling (`file:` entries are copies that pnpm does not refresh):

```bash
dsh plugin --profile web add link:C:/path/to/plugins/dsh-cache-guard
```

## Configuration

The host row governs. A preset row's config applies only where the host half is absent — an engine is wrapped once, by whoever gets there first, and the host plane always announces before a preset row applies.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `manual` | `manual` asks before an automatic surface change; `auto` only reports it; `off` leaves the operation to the engine as shipped |
| `pricePerMTokens` | unset | full-price input rate per million tokens; adds a currency amount to the dialog and the pill |
| `estimatedSummaryTokens` | `4000` | assumed checkpoint size used when pricing a planned summarization |

The **trigger threshold** belongs to the engine, not to the guard: it is the `compaction-basic` row's `thresholdRatio` (default `0.8`, i.e. compact once 80% of the routed window is in use). The installer can set it — it patches that row's config in the generated preset, which is the whole of that row's config because a patch replaces rather than merges:

```bash
node tools/install-profile.mjs --threshold 0.9
```

## Verification & Testing

```bash
npm test                                   # unit and contract tests
node tools/simulate-session.mjs 02abdc01   # price a real session's first automatic rewrite
node tools/install-profile.mjs --dry-run   # show what the installer would change
node tools/verify-preset.mjs ~/.dsh/.agent-presets/cache-guard/agent.cordis.yml
dsh web --dump-config | Select-String cache-guard
```

`tools/simulate-session.mjs` truncates a real session log to the moment before its first automatic rewrite, rebuilds a real `Session`, prices the pending plan through the real token meter and the real pruner, and compares the prediction with the provider usage the log recorded afterwards. On the session above it predicted 28 rewrites, the first change at surface position 8, and 724,447 cold tokens — against 28 rewrites and 720,764 actual full-price tokens: **0.5 % off**.

`tools/verify-preset.mjs` composes a preset file through a real Loader and prints what it contains — every row, the `compaction` group's children, and the config the engine row carries. It answers the question a config change raises and a file read does not: does the threshold this profile defaults to actually reach `compaction-basic`, and is the engine row still inside the group. Rows mount as stubs, so it needs no service, no model, and no running server.

## Known Limitations

- **The cold split is calibrated, not guaranteed.** The request total comes from the harness's own pressure number (provider-anchored where the session has provider usage); the fixed part is read from the session's cheapest real request. A very large opening message makes the fixed part slightly high and the cold estimate slightly low.
- **The checkpoint size is an estimate** — a planned summarization is priced with `estimatedSummaryTokens`, because the real summary does not exist before it runs. Prune numbers are exact, and the plan states which of the two it is.
- **The per-session mode is process-local.** "Allow automatically for this session" lasts until the harness restarts; a durable record would need a session event type this build knows, which an out-of-repo plugin cannot add.
- **A declined overflow still ends the turn.** At a provider-confirmed context overflow the window is already exhausted, so declining preserves the original provider error.
- **The plan mirrors the engine's resolution.** The trigger ratio, the retention budget, the routed provider/model (from the durable `request/header` the engine itself reads), and the safe-cut rule are recomputed here from the public engine config and the session surface — because the guard selects the range it replaces. A change upstream must be followed here; a range the engine rejects leaves the surface untouched and logs the failure.
- **A profile without the host half is not guarded at all.** The gate is installed by the bundle's host row; a profile that composes without it (or disables it) has no veto, no dialog, and no pill. The preset row covers that case, one preset at a time.
- **The pill's reassurance is derived, not promised.** `Cache: ask` means the process guards at least one engine; a fresh session confirms it after its first step, when the live context line appears. `Cache: not armed` is the honest answer when nothing is guarded.
- **A pricing failure spends rather than strands.** If the guard cannot price an operation it hands the operation to the engine and says so in the log. That is the same cache cost the session would have paid without the plugin — deliberately chosen over declining every rewrite in every session.
- **A profile with no question provider blocks rather than spends.** With `mode: manual` and nothing to ask, the guard declines and logs it; the session then runs to its window limit. Use `mode: auto` for a headless profile's row.
- **Everything but the harness vocabulary is English.** Code, comments, docs, dialog copy, and the pill are English; only the harness terms the guard reports (`compaction/prune`, `thresholdRatio`, `retainRatio`) keep their upstream spelling.

## 🤝 Contributing

Keep the layout: one module per concern under `lib/`, one test file per module under `test/`, every claimed measurement traceable to a real session. Run `npm test` before and after a change.

## 🔗 Links

- [📚 DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [🐛 Issues](https://github.com/loonylabs-dev/dsh-cache-guard/issues)
- [📦 NPM Package](https://www.npmjs.com/package/dsh-cache-guard)

## License

MIT © [loonylabs-dev](https://github.com/loonylabs-dev)

---

<div align="center">

**Maintained by [loonylabs-dev](https://github.com/loonylabs-dev)**

</div>
