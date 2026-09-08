# Supervisor rewrite recovery

The supervisor could fail with “requested a task rewrite without supplying changed
requirements” even when it supplied a useful correction to verification checks.
Requirements comparison always labeled corrections as task rewrites, while the
orchestrator correctly required those decisions to change the task description.
Separately, progress parsing accepted unchanged replacements, bypassing its repair
turn and failing only when the orchestrator attempted to apply them.

## Behavior

- Requirements corrections that change only checks use
  `STOP_AND_REWRITE_VALIDATION`, preserving the task description. This applies to
  the standalone requirements helper; live supervision uses one progress decision
  that includes owner requirements, not an extra preliminary model comparison.
- An incompatible requirements decision must change at least one contract field.
  A repeated contract, including whitespace-only changes, receives one repair turn.
- Progress rewrites are compared with the current task/checks before application.
  Missing or unchanged replacements receive one compact repair turn with owner
  instructions, the current contract, the proposed decision, and the parse error.
  The repair does not replay the full project goal, journal, or executor handoff
  or reopen the investigation. Work and its captured evidence remain in storage.
- Clearing an invalid verification command remains supported.
- If the repair is still invalid, the review reports an error and preserves work.
  It never treats a rejected or unreadable rewrite as permission to verify.
- Existing stale-evidence, cancellation, and defensive application guards remain.

## Regression checks

Run `node --test scripts/*.test.cjs`, `npm run typecheck`, and `npm run build:ext`.
`scripts/queue-rewrite.test.cjs` covers successful repairs through application,
checks-only corrections through both the standalone helper and single-pass live
review, repeated invalid responses, retained handoffs, compact repair context,
bounded usage, command removal, and valid decisions that need no repair.

These are deterministic tests with model/VS Code doubles and real queue storage;
they do not establish live model compliance or an end-to-end VS Code UI result.
