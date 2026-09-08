# Replace rejected tasks, not endless retries

## Transition

Unsuccessful verification at the existing bounded recovery boundary no longer
writes terminal `FAILED`. A halted supervisor test repair, including an attempted
application-file edit rejected by queue ownership, enters mandatory decomposition.
The ownership boundary stays enforced: a test-repair turn cannot edit application
implementation.

The supervisor receives the original planner prompt (`goal`), current owner and
testing instructions, unchanged task/checks, captured errors, handoff, and ancestor
contracts. Its only accepted decision is a complete `SPLIT` containing at least two
smaller ordered tasks. An explicit outcome partition and original-contract coverage
map accompany the plan. These are auditable planning claims, not proof of correctness.

The host rejects duplicate children, parent/ancestor copies, missing checks, dropped
contract fields, and incomplete plans. All replacement rows are committed together
and the original row is deleted in the same SQLite transaction. Its contract,
reports, journal, and usage remain archived; working files are not reverted.

## Existing queues

Opening a database migrates old `FAILED` rows to `VERIFYING` with
`decomposition_required`. SQLite triggers enforce the same transition for older
clients that still write `FAILED`. Marked parents cannot become executable or
verified through stale callbacks, manual status controls, Start, or Reset. The next
running supervisor cycle plans their replacement; it never resumes their old task.

`FAILED` is removed from selectable UI/MCP statuses. Decomposition progress is
visible as the task's activity while its replacement is pending.

## Repetition controls

- One planning call and at most one response repair per admitted decision.
- Invalid plans wait for changed workspace, owner requirements, or observed
  evidence. Waiting does not make the parent runnable or claim success.
- Transport/commit errors have persisted backoff and at most three admissions for
  the same input. Reload, Start, Reset, heartbeats, and A-to-B-to-A input cycling
  do not replenish that allowance.
- Recursive replacement reserves a family-wide allowance of 32 splits without a
  new verified family outcome. Removing/reappearing old proof cannot replenish it.
  This prevents unverified task multiplication, including paraphrased cycles.
- Stop/Pause, owner edits, changed worker evidence, and changed workspace invalidate
  an in-flight plan. A rejected SQL transaction leaves the original intact.

The scheduler remains running while waiting for a meaningful change, rather than
spending indefinitely on the same rejected decision. No system can guarantee that
a model will produce a valid plan or that unavailable external services will recover.

## Verification

`node --test scripts/*.test.cjs`, `npm run typecheck`, and `go test ./...` in `core`
cover storage migration, native/UI status handling, the ownership rejection,
transaction rollback, retained evidence/cost, cancellation, cron-to-child execution,
and durable repetition guards. Model turns are deterministic doubles; these tests
do not claim a completed production task or live-model compliance.
