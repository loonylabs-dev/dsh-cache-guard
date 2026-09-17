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
  Breaks the cache at position 8: 724k re-read in full (97% of the request)
  [ Allow once ]  [ Not now ]  [ Always allow (this session) ]
```

And a pill in the composer's tool row — inside the input card, right after the access-mode chip. It carries the mode only; clicking it opens a small menu with the numbers:

```
[ Cache: ask ]          ╭───────────────────────────────────────────╮
                        │ Context 837k of 1.05M · rewrite at 839k   │
                        │ last rewrite: 28 tool results pruned ·    │
                        │ 724k re-read in full (declined, nothing   │
                        │ changed)                                  │
                        │ ───────────────────────────────────────── │
                        │ ● Ask before every rewrite                │
                        │ ○ Allow automatically                     │
                        ╰───────────────────────────────────────────╯
```

The long sentence also sits in the pill's tooltip, so hovering shows it without opening the menu. The host keeps the chosen mode per session.

## Where It Is Active

Two halves with different reach:

| Half | Lives in | Reach |
|---|---|---|
| host | the profile bundle | **every** session: the pill, its menu, and the mode endpoints |
| engine | the agent preset, inside the `compaction` group | only sessions composed on the guarded preset: the veto, the dialog, and the live numbers |

A session composed on a preset without the engine row — the shipped `standard`, for example — compacts and prunes exactly as before, and the pill has nothing to report there. That is why the installer makes the guarded preset the default: new sessions are guarded without picking anything, and the composition they run is still the shipped one. Sessions that started earlier keep the composition they began with.

## How It Intercepts

Both operations run through **one** method — `compactIfNeeded` on the live compaction engine. Pruning is the first phase inside that call, summarization the second, and the provider-overflow recovery path enters the same method. `compaction-basic` registers its listeners with `this` bound to the engine instance and calls `this.compactIfNeeded(...)` internally, so replacing the instance method intercepts both paths. Wrapping the `compaction` service would not.

The guard therefore:

1. prices the pending plan **before** anything is touched — which tool results are over the pruner's budget (the real pruner's own `pruneContent` decides, without mutating), whether a summarization would follow, and how many tokens break the cache at which surface position;
2. asks (manual mode) or reports (auto mode);
3. calls the original method on accept, or returns `null` on decline — which the engine reads as *nothing to compact*, leaving the surface and the warm cache untouched.

Nothing is imported from the compaction packages and no engine code is changed: the guard reads the engine's public config and the public services of its context, and restores the original method when it unloads.

## Guarantees

- **A guard bug never blocks the engine.** If pricing throws, the original call runs and the failure is logged.
- **Fail closed on silence.** With the mode set to `manual` and no question provider registered, the automatic rewrite is declined and the log says how to allow it (`mode: auto`).
- **No repeat nagging.** A decline mutes the guard for the rest of the current turn instead of asking at every step.
- **No new session event types.** The bundle adds no `SessionEventMap` member: an event type this build does not know would make the session log unreadable to the very build that wrote it. The client surface derives everything from existing events and the guard's own state.
- **Zero runtime dependencies.** The package imports nothing outside itself, so it cannot bind to a second copy of a harness class.

## Installation

```bash
dsh plugin --profile web add file:C:/path/to/plugins/dsh-cache-guard
```

The engine half must be mounted **inside the preset's `compaction` group** — that group isolates the `compaction` and `toolResultPruner` services, so a row outside it cannot see the engine it has to wrap. The installer writes a preset that **includes the shipped composition and patches that one row in**, and makes it the default for new sessions:

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

The default comes from the `agent-presets` settings namespace (`--no-default` leaves it alone):

```yaml
# ~/.dsh/settings.yaml
agent-presets:
  default: cache-guard
```

A preset is chosen when a session starts, so a running session keeps the composition it began with: restart the harness and start a **new session**. The log then shows `dsh-cache-guard: engine guarded (mode manual)`, and the pill's menu shows the live context line. Reverting is deleting those two lines, or picking another preset for the next session.

For plugin development, install it as a link so edits apply without reinstalling (`file:` entries are copies that pnpm does not refresh):

```bash
dsh plugin --profile web add link:C:/path/to/plugins/dsh-cache-guard
```

## Configuration

Both halves read the same keys; the preset row wins over the host row.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `manual` | `manual` asks before an automatic surface change; `auto` only reports it |
| `pricePerMTokens` | unset | full-price input rate per million tokens; adds a currency amount to the dialog and the pill |
| `estimatedSummaryTokens` | `4000` | assumed checkpoint size used when pricing a planned summarization |

## Verification & Testing

```bash
npm test                                   # unit and contract tests
node tools/simulate-session.mjs 02abdc01   # price a real session's first automatic rewrite
node tools/install-profile.mjs --dry-run   # show what the installer would change
dsh web --dump-config | Select-String cache-guard
```

`tools/simulate-session.mjs` truncates a real session log to the moment before its first automatic rewrite, rebuilds a real `Session`, prices the pending plan through the real token meter and the real pruner, and compares the prediction with the provider usage the log recorded afterwards. On the session above it predicted 28 rewrites, the first change at surface position 8, and 724,447 cold tokens — against 28 rewrites and 720,764 actual full-price tokens: **0.5 % off**.

## Known Limitations

- **The cold split is calibrated, not guaranteed.** The request total comes from the harness's own pressure number (provider-anchored where the session has provider usage); the fixed part is read from the session's cheapest real request. A very large opening message makes the fixed part slightly high and the cold estimate slightly low.
- **The checkpoint size is an estimate** — a planned summarization is priced with `estimatedSummaryTokens`, because the real summary does not exist before it runs. Prune numbers are exact, and the plan states which of the two it is.
- **The per-session mode is process-local.** "Allow automatically for this session" lasts until the harness restarts; a durable record would need a session event type this build knows, which an out-of-repo plugin cannot add.
- **A declined overflow still ends the turn.** At a provider-confirmed context overflow the window is already exhausted, so declining preserves the original provider error.
- **The plan mirrors the engine's resolution.** Threshold and retention are recomputed from the public engine config with the documented formulas (`resolveTargetPolicy`, `resolveCompactSpec`), and the routed provider/model come from the durable `request/header` the engine itself reads. A change upstream must be followed here.
- **A session composed without the engine half is not guarded.** The veto lives in the agent preset, so a session started on a preset that lacks the row (the shipped `standard`, for instance) compacts exactly as before. That is why the installer makes the guarded preset the default; sessions that started earlier keep their composition either way.
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
