# Failed tasks are split into smaller tasks

## When a task fails

A task fails when:

- its executor stops working: the turn ends without `READY_FOR_VALIDATION`
  (unfinished, cut off by the core, or crashed), or the worker goes silent for
  `mfagent.queue.workerSilentMinutes`;
- the supervisor reads the running executor's journal and finds it in an infinite
  loop (the same tool call with the same result, repeated), or down a rabbit hole
  (a supervisor review, at most once per `mfagent.queue.reviewIntervalSeconds` and
  only when the executor has done something new);
- a supervisor test repair halts.

A failed task is never retried as it was. It is replaced by smaller tasks and the
original row is deleted. The one exception is a model-provider or network outage
(`providerUnavailable`): that says nothing about the task, so the task is retried.

## How the split lands

Every failure calls `requestFailureDecomposition`, which stops a running executor
and marks the row `VERIFYING`/`decomposition_required`. Every supervision tick,
before the pump starts a worker, `serviceSplits` replaces it, using the first of:

1. the executor's own proposal, when its completion report carried `splitInto`;
2. one planner turn (`decideFailureDecomposition`), limited to five minutes, with
   one repair of an unusable answer;
3. `mechanicalSplit`: the description's own list items or sentences become ordered
   steps, and a task too small to divide becomes "fix what stopped the last
   attempt", then "finish".

`normalizeSplitParts` repairs proposals instead of refusing them. Entries without a
title or description, and copies of the original, an ancestor, or a sibling, are
dropped; a replacement listing more than three files becomes one task per group of
three; the last replacement also runs the original acceptance check. All
replacements commit and the original row is deleted in one SQLite transaction. Its
contract, reports and journal stay archived, and working files are kept.

## Bounds

A family may split 32 times without a new verified outcome. `familySplitBudgetLeft`
checks that allowance before a planner turn is spent. An exhausted family is
rebuilt from its original task (a fresh family, split afresh), and after two
rebuilds the executor works on the original task directly. The decomposition
trigger (`tasks_decomposition_update`) only accepts a row that stays waiting for its
split or returns to the executor through `executor_recovery`, so every write in
this lane is one of those two.

## Verification

`node --test scripts/split-recovery.test.cjs` drives the real tick, pump and SQLite
queue with the model and executor stubbed at their source modules: an unfinished
executor, an executor-proposed split, an unusable or unanswering planner, a silent
worker, a loop and a rabbit hole in the journal, a provider outage (retried), and an
exhausted family. `scripts/ownership-recovery.test.cjs` covers halted repairs and
`scripts/blocked-recovery.test.cjs` the claim ordering around a failed task.
