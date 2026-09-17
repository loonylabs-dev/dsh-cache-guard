# CLAUDE.md — dsh-cache-guard

Session rules for working ON this repository. The README describes how to install
and configure the plugin; this file binds how sessions CHANGE it. It stays small:
rules that bind every session and were paid for once.

## Start of session

- The gate is `npm test` (52 tests, seconds). Green before AND after a change;
  nothing gets committed on a red or unrun gate.
- `npm run test:unit` needs no harness packages; `npm run test:integration` does.
- Verify a real installation with `node tools/install-profile.mjs --dry-run`, and
  price a real session with `npm run simulate <sessionId>`.

## Hard rules, each one paid for

- **The guard never blocks the engine on its own failure.** Pricing throws → the
  original `compactIfNeeded` runs and the warning is logged. A guard bug may cost
  money; it may never strand a session.
- **A decline is `null`, never a mutation.** The engine reads `null` as "nothing to
  compact", which leaves the surface and the warm cache untouched. Never implement
  a decline by editing the session.
- **Import nothing from a harness package in `index.js` / `engine.js`.** A second
  copy of a harness class — above all cordis — breaks service identity. Read
  services off the context instead. One test enforces this; do not relax it.
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
  may be fakes; the engine, meter, pruner, and Loader may not. `test/real-engine.test.mjs`
  and `test/preset-composition.test.mjs` are the bar.
- **Everything in English** — code, comments, docs, dialog and pill copy.

## Where learnings get filed

| Learning about | Goes to |
|---|---|
| A wrong or right prediction against a real log | `tools/simulate-session.mjs` output + a comment in `lib/cold-cost.js` |
| The engine's interception path or service visibility | `lib/gate.js`, `engine.js`, and this file |
| The preset shape, isolation, or installation | `lib/preset-file.js`, `tools/install-profile.mjs`, README |
| The dialog or the pill | `lib/gate.js` (dialog), `client.js` (pill), README examples |
| A harness behavior the plugin mirrors | The mirroring function plus a Known Limitation entry |

## Commit style

Thematic commits. The subject is a claim, the body carries the measurement:

`fix: price against the request header — the engine reads it, and a model switch priced the wrong target`
