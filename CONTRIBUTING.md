# Contributing

This repository gates the automatic context operations that break a provider's prefix cache — tool-result pruning and summarization — by pricing them first and asking a human before they land.

Every number the plugin shows corresponds to a measurement on a real session, and every test asserts a behavior, not a shape.

## What the code here is like

Five rules govern changes to this repository:

**1. The guard never blocks the engine on its own failure.** If pricing throws, the original `compactIfNeeded` call runs and the failure is logged. A guard bug may cost money; it may never strand a session by refusing to let the engine work.

**2. Declining is expressed as `null`, never as a mutation.** The engine reads a `null` result as "nothing to compact", so a decline touches neither the surface nor the warm cache. Do not implement a decline by editing the session, and do not import an engine module to reach around the method.

**3. Nothing is imported from a harness package.** `index.js` and `engine.js` resolve every dependency from their own directory, and one test enforces it. A second copy of a harness class — cordis especially — is the failure this rule exists to prevent. Measurements come from services read off the context, never from a helper package.

**4. The numbers are two-currency by construction.** The request *total* comes from the harness's pressure number (provider-anchored when the session has provider usage); the *split* between warm and cold comes from positional node prices, with the fixed request part read from the session's cheapest real request. Mixing the two the other way — deriving the fixed part from the meter's residual — was measured 12% wrong on a real session; the comment in `lib/cold-cost.js` records that.

**5. No new session event types, ever.** An out-of-repo event type would make the session log unreadable to the very build that wrote it, because such a build does not know the type and `Session.append()` cannot mark it ignorable. The client surface derives everything from existing events and the guard's own state.

## Layout

| Path | Owns |
|---|---|
| `index.js` | the host half: the `cacheGuard` service and the two loopback routes |
| `engine.js` | the engine half: the instance wrapper, installed inside an agent preset |
| `client.js` | the browser half: the composer pill and its menu |
| `lib/cold-cost.js` | the pricing arithmetic and its formatters |
| `lib/plan.js` | what the engine is about to do, rebuilt from public inputs |
| `lib/gate.js` | the decision, the dialog, and the engine-method wrapper |
| `lib/policy.js` | the per-session policy and the records the pill reads |
| `lib/host-routes.js` | the state and mode endpoints |
| `lib/preset-file.js` | the guarded preset's composition text |
| `tools/install-profile.mjs` | profile checks, preset generation, default preset |
| `tools/simulate-session.mjs` | price a real session's first automatic rewrite |
| `tools/verify-preset.mjs` | compose a preset file through a real Loader and print what it contains |

## Testing

```sh
npm install               # the harness packages the integration lane imports
npm run test:unit         # no harness packages needed; fakes only
npm run test:integration  # real engine, real meter, real Loader
npm test                  # both
```

The integration lane imports harness packages, which resolve from this package's
`node_modules`. CI installs them from the registry through `devDependencies`. On a
development machine that already runs a harness, a junction to that installation
serves the same purpose without a download (and is what `plugins/dsh-pathfix`
does too):

```powershell
New-Item -ItemType Junction -Path node_modules `
  -Target "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules"
```

It is gitignored, and an `npm` command run in this directory can prune it.

The integration lane is the one that matters for a claim like "the dialog is reachable": it mounts the shipped compaction engine, meter, and pruner in one context and drives them through the engine's own `agent/pre-step` path. Keep that bar for any change to the interception.

Two measurements may not be replaced by assertions on shapes:

* the pricing must keep matching a real log (`npm run simulate <sessionId>`), and
* the generated preset must keep composing in a real Loader (`test/preset-composition.test.mjs`).

## Commits

Thematic commits. The subject is a claim, the body carries the measurement that supports it and the reason it matters:

`fix: read the routed model from the request header — the engine does, and a switch priced the wrong target`

## Version and changelog

`CHANGELOG.md` is part of a change, not a release chore: a commit that alters
behavior, output, or the public surface updates it in the same commit, and the
entry leads with the claim the change makes rather than with the file it touched.

The version says which kind of change it was:

| Change | Bump |
|---|---|
| A feature addition | minor — `0.x.0` |
| A fix, a documentation change, a test change, a manifest change | patch — `0.0.x` |

`prepublishOnly` runs `npm test`, so the publish path is the release gate: a red
suite publishes nothing.

## Everything in English

Code, comments, docs, dialog copy, and commit messages are English. Only harness vocabulary the plugin reports keeps its upstream spelling.
