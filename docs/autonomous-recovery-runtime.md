# Autonomous recovery and host verification

The controller must remain `RUNNING` while unfinished work has an automatic
recovery path. Retry exhaustion is not an instruction to pause the entire run.
Explicit operator Pause/Stop still cancel and fence in-flight work. A completed
queue may become idle; an incomplete queue must not pretend to have finished.

## Recovery is durable work

`recoverySchedule.ts` persists a task-specific job with a due time, attempt
count, diagnosis, and operational fingerprints. A failed operation receives
bounded exponential backoff. Start, reload, Check now, and watchdog ticks cannot
bypass the saved deadline or reset the failure history.

The recovery decision protocol has four actions:

* **EXECUTE** a concretely changed implementation or expansion approach.
* **VERIFY** through independently executed checks.
* **SPLIT** by committing every replacement and retiring the original in the
  same SQL transaction. The parent is archived, not left runnable.
* **WAIT** for a bounded automatic dependency recheck without pausing the queue.

No success, stop, acceptance rewrite, or counter-reset action exists in this
protocol. Changed prose is not a changed operation. Real changed tool evidence
can justify retrying an operation after its cause has changed.

Legacy automatic pauses migrate on Start to scheduled recovery. Task contracts,
attempt counts, output, and verification history remain intact. Ordered work
barriers remain conservative: this change does not run dependent children ahead
of unfinished shared prerequisites.

## Verification produces receipts, not imagined execution

The verification model proposes a typed, bounded plan against the real tool
registry and its JSON schemas. The host invokes shell and browser/tool steps
separately. RPC tool names are not shell executables. Each required step gets a
captured result, dependency status, and machine-checkable assertion where
applicable. Invalid plans execute no steps.

A separate tool-disabled reporting turn receives those receipts. Missing,
failed, or unbound evidence cannot establish a passing report. The supervisor
still judges substantive acceptance; a successful tool call alone does not
prove application correctness. Existing malformed check adapters can be
diagnosed without changing the owner's task or pretending their assertions ran.
REVERIFY cannot persist command or scope-baseline edits. Exact journal provenance
distinguishes an old extension-invented adapter from genuine owner acceptance.
Missing observations and malformed checks cannot, by themselves, authorize a
product-edit retry. An explicit failed assertion is required for that path.

Verification rejects direct source-edit tools, but this is not a filesystem
sandbox: shell tests can write normal build/test outputs. Tool deadlines and
operator cancellation remain necessary safeguards.

Windows script dispatch retains the exact resolved shim and propagates native
and PowerShell failures. A different same-name script must not be selected by a
second shell, nor may a parser error become a successful verification receipt.

## Verification of this change

Regression tests cover actual Start/tick/recovery orchestration, durable SQLite
reopen, deadlines, changed-operation admission, atomic replacement, stale
callbacks, user cancellation, and host evidence binding. The optional
`scripts/verification-replay.cjs` harness uses the configured provider against
an isolated workspace/queue copy. Replay artifacts stay in ignored `out/` and
must never be shipped in the VSIX. Tests and replay findings are evidence about
the controller, not proof that the owner's application task has been completed.
