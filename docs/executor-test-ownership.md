# Executor test ownership

The old guard rejected edits to any existing test, even when the assigned feature
required changes to source, tests, and JSON configuration. It transferred that
task to a supervisor repair worker, whose guard correctly rejected application
configuration edits. Repeating or splitting the task did not resolve the role
mismatch.

Execution turns now own source, existing tests, and configuration: implementation
includes its tests, and a file extension does not transfer an executor's assigned
work to another role. That policy lives in `core/internal/tools/queue_ownership.go`.

A dedicated supervisor test-repair turn is confined to tests, fixtures, and test
harnesses. When a repair shows that an application or production-config change is
required, the guard refuses the write, and the refusal says the task is split so
that change becomes its own smaller task; a repair never rewrites the product to
make a test pass. `repairTests` (`src/queue/orchestratorProgress.ts`) aborts the
repair on its first `queue ownership:` refusal and calls
`requestFailureDecomposition`: the `[SUPERVISOR_TEST_REPAIR]` marker is cleared,
the refusal stays in the error history the replacement tasks inherit, and
`serviceSplits` replaces the task on the same tick. A repair that halted once is
never restarted. `docs/failure-decomposition.md` describes how every failed task
is split.

A halted repair used to be parked for decomposition with its marker still set.
The keep-alive tick had no split step then, and the marker keeps a row out of
`drainVerification`, so the same halted repair was re-requested on every tick: on
a live Parnassus queue, 1,954 `test-repair-requested` events over 20 hours on one
task, with every later task held behind it. `serviceTestRepairs` now skips any row
waiting for its split.

Native file tools and the Claude PreToolUse hook use the same policy. Required
assertions, task scope, queue storage protection, and explicitly read-only
reviews/verification remain intact.

On a running queue, stopped PENDING/VERIFYING rows carrying the old installed
core's ownership failure receive one executor migration retry. Output, history,
acceptance checks, and attempts are preserved. That migration matches only the old
wording (`...preserving the original owner goal`) and never touches a row already
waiting for its split; that row is split instead. The migration is recorded only
after its write has landed: `tasks_decomposition_update` silently reverts a patch
that moves a decomposition-bound row anywhere except `PENDING`/`executor_recovery`,
and a build that recorded the migration anyway left every later build treating
the still-stopped row as already handled. Legacy BLOCKED rows automatically return
to the executor before later tasks run; PAUSED rows wait for Start, and genuine
explicit test-repair requests keep their lane.

Checks cover native ownership, the real CLI hook, role-specific CLI prompts, and
queue recovery using real SQLite with the model transport stubbed, including the
reported live row (a reverted migration on a decomposition-bound task) and a
hook-refused repair, each run across repeated ticks. No live product queue or
Parnassus files are modified while testing.

The error path under `.vscode/extensions/mflores.mf-agent-0.1.53/bin/mfcore.exe`
identifies an installed extension binary, not this workspace's `bin/mfcore.exe`.
Rebuilding the workspace alone does not update it. Install the rebuilt VSIX and
reload VS Code before retrying; the queue recovers already blocked tasks
automatically.
