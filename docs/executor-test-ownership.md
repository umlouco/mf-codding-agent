# Executor test ownership

The old guard rejected edits to any existing test, even when the assigned feature
required changes to source, tests, and JSON configuration. It transferred that
task to a supervisor repair worker, whose guard correctly rejected application
configuration edits. Repeating or splitting the task did not resolve the role
mismatch.

Execution and authorized repair turns can now edit every project file type,
including source, existing tests, configuration, and documentation. Native file
tools and the Claude PreToolUse hook use the same policy. Required assertions,
task scope, queue storage protection, and explicitly read-only reviews/verification
remain intact. Repair turns can also make necessary application changes.

On a running queue, stopped PENDING/VERIFYING rows with this old ownership failure
receive one executor migration retry before the legacy verification drain. Output,
history, acceptance checks, and attempts are preserved. Exhausted budgets remain
blocked; PAUSED/BLOCKED tasks are not automatically resumed. A recurrence after
migration blocks with an installed-core update message instead of another repair
loop. Genuine explicit test-repair requests keep their existing lane.

Checks cover native ownership, the real CLI hook, role-specific CLI prompts, and
queue recovery using real SQLite with the model transport stubbed. No live product
queue or Parnassus files were modified while testing.

The error path under `.vscode/extensions/mflores.mf-agent-0.1.53/bin/mfcore.exe`
identifies an installed extension binary, not this workspace's `bin/mfcore.exe`.
Rebuilding the workspace alone does not update it. Install the rebuilt VSIX and
reload VS Code before retrying; already blocked tasks need an explicit retry.
