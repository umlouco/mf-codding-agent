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
required, the guard refuses the write and asks for a `SPLIT_TASK` decision; the
host replaces the task with an ordered split that separates the implementation
change from its verification, instead of letting a repair rewrite the product to
make a test pass. `src/queue/orchestratorProgress.ts` routes a repair whose journal
recorded a `queue ownership:` failure into failure decomposition.

Native file tools and the Claude PreToolUse hook use the same policy. Required
assertions, task scope, queue storage protection, and explicitly read-only
reviews/verification remain intact.

On a running queue, stopped PENDING/VERIFYING rows carrying the old installed
core's ownership failure receive one executor migration retry. Output, history,
acceptance checks, and attempts are preserved. That migration matches only the old
wording (`...preserving the original owner goal`); a current test-repair refusal
is not migrated and instead enters decomposition. Legacy BLOCKED rows
automatically return to the executor before later tasks run; PAUSED rows wait for
Start, and genuine explicit test-repair requests keep their lane.

Checks cover native ownership, the real CLI hook, role-specific CLI prompts, and
queue recovery using real SQLite with the model transport stubbed. No live product
queue or Parnassus files are modified while testing.

The error path under `.vscode/extensions/mflores.mf-agent-0.1.53/bin/mfcore.exe`
identifies an installed extension binary, not this workspace's `bin/mfcore.exe`.
Rebuilding the workspace alone does not update it. Install the rebuilt VSIX and
reload VS Code before retrying; the queue recovers already blocked tasks
automatically.
