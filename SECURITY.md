# Reporting a vulnerability

**info@loonylabs.dev**, or GitHub's private vulnerability reporting if enabled on this repository.

Please do not open a public issue for an exploitable security defect. There is no bounty and no SLA — reports will be reviewed and answered promptly.

## What is worth reporting

`dsh-cache-guard` sits in front of the harness's automatic context rewrites: it prices a pending change, asks the human, and either lets the engine's own method run or returns "nothing to compact". Two properties therefore matter:

* **A rewrite that lands despite a decline.** Any path where the guard answers "not now" and the surface is still rewritten (or a summarization call still runs) — that is the plugin's whole promise.
* **A forced silence that costs money.** Any path where the guard suppresses the engine's provider-overflow recovery without the human having decided, leaving a session to fail or to keep spending.
* **Unauthorized mode changes.** `GET /cache-guard/state` and `POST /cache-guard/mode` are unauthenticated loopback routes: they change the guard's mode for a session id the caller supplies. Beyond that they read and write nothing. Report any way they reach beyond that, or any way a page can use them to make a session rewrite without a human seeing the dialog.
* **Leaked content.** Any defect where the guard's log lines, the dialog, or the host endpoints expose more of a session than the numbers it prices (token counts, positions, model names).

## What is not a vulnerability here

* **Compaction and pruning themselves.** The plugin does not implement either; it gates the harness's own. Whether a rewrite is safe for a given session is `dsh-compaction-basic`'s and `dsh-compaction-tool-result-pruner`'s contract.
* **A session composed without the guard.** A preset that does not carry the engine row compacts exactly as the shipped harness does. That is a configuration, not a defect — see the README on where the two halves are active.
* **Numbers that differ from your provider's bill.** The cold re-read is priced through the harness's own meter, and the checkpoint size is an estimate. A different figure on an invoice is expected; a *systematically* wrong split is worth reporting with the session log excerpt that shows it.
* **An unanswered dialog.** The guard waits indefinitely by design: an unanswered question costs nothing, and the session simply does not continue until it is answered.

## Please do not send

Live session logs containing API keys, credentials, or proprietary prompt text. Reduce a defect to a small synthetic fixture — `test/gate.test.mjs` and `test/real-engine.test.mjs` show how to build a session and a composition without any of them.
