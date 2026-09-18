# CLAUDE.md — dsh-cache-guard

Session rules for working ON this repository. The README describes how to install
and configure the plugin; this file binds how sessions CHANGE it. It stays small:
rules that bind every session and were paid for once.

## Start of session

- The gate is `npm test` (75 tests, seconds). Green before AND after a change;
  nothing gets committed on a red or unrun gate.
- `npm run test:unit` needs no harness packages; `npm run test:integration` does.
- Verify a real installation with `node tools/install-profile.mjs --dry-run`, and
  price a real session with `npm run simulate <sessionId>`.

## Hard rules, each one paid for

- **The guard never blocks the engine on its own failure.** Pricing throws → the
  original `compactIfNeeded` runs and the warning is logged. A guard bug may cost
  money; it may never strand a session. `decide()` still returns "declined" for its
  own decisions (a human's no, no answerer, nothing to decide); the wrapper hands
  the call back to the engine only when it could not price the operation.
- **A decline is `null`, never a mutation.** The engine reads `null` as "nothing to
  compact", which leaves the surface and the warm cache untouched. Never implement
  a decline by editing the session.
- **Import nothing from a harness package in `index.js` / `engine.js`.** A second
  copy of a harness class — above all cordis — breaks service identity. Read
  services off the context instead. One test enforces this; do not relax it.
- **The gate is installed from the host plane; a preset row is the fallback.** An
  agent's engine is created inside its preset's `isolate` realm, so only a listener
  on `internal/service` registered with `{ global: true }` hears the registration:
  the event carries a scope filter that drops every other listener. That is how
  `lib/global-gate.js` covers every preset without editing one, and why installing
  the bundle is the whole opt-in. Dropping `global` disarms every session silently.
- **Wrap the raw instance and price through its own context.** The announced value is
  a traced read, so `value.ctx` answers with the READING context — the host plane,
  which resolves no pruner and no realm meter. Take the target behind it
  (`value[Symbol.for('cordis.original')]`) and use that instance's `ctx`. The
  realm-pricing test catches a regression that is silent in production: the plan
  would claim there is nothing to prune.
- **Identify a wrapper by the marker on the FUNCTION.** A traced read hands back a
  fresh proxy for the same method on every read, so `engine.compactIfNeeded` never
  compares equal to the wrapper that was installed. `GATE_MARK` (`Symbol.for`, so
  two installed copies agree) is what tells an installer and its disposer their own
  work.
- **Read the routed target from the request header.** The engine resolves its
  provider/model from `session.requestHeader()?.config`; reading the
  `request/context` event instead priced the wrong target (found by the
  real-engine test).
- **The pricing is two-currency.** Request total from the harness pressure number,
  warm/cold split from positional node prices, fixed part from the session's
  cheapest real request. The other mixing (`totalTokens - surfaceTokens` as the
  fixed part) was measured 12% wrong; see the comment in `lib/cold-cost.js`.
- **Never add a `SessionEventMap` member.** An out-of-repo event type makes the log
  unreadable to the build that wrote it, because `Session.append()` cannot mark it
  ignorable. The pill reads existing events plus the guard's own state.
- **The engine row must stay INSIDE the preset's `compaction` group.** That group
  isolates `compaction` and `toolResultPruner`; a row outside it cannot see the
  engine it wraps. The generated preset patches it in rather than copying the
  shipped composition, so harness updates keep flowing.
- **Mock only the two external things.** The LLM adapter and the question provider
  may be fakes; the engine, meter, pruner, and Loader may not. `test/real-engine.test.mjs`,
  `test/global-gate.test.mjs`, and `test/preset-composition.test.mjs` are the bar.
- **Everything in English** — code, comments, docs, dialog and pill copy.

## Where learnings get filed

| Learning about | Goes to |
|---|---|
| A wrong or right prediction against a real log | `tools/simulate-session.mjs` output + a comment in `lib/cold-cost.js` |
| The engine's interception path, realm reach, or service visibility | `lib/gate.js`, `lib/global-gate.js`, `engine.js`, and this file |
| The preset shape, isolation, or installation | `lib/preset-file.js`, `tools/install-profile.mjs`, README |
| The dialog, the pill, or what the pill may claim | `lib/gate.js` (dialog), `client.js` (pill), `lib/host-routes.js` (state payload), README examples |
| A harness behavior the plugin mirrors | The mirroring function plus a Known Limitation entry |

## Commit style

Thematic commits. The subject is a claim, the body carries the measurement:

`fix: price against the request header — the engine reads it, and a model switch priced the wrong target`
