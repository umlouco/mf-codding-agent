# Supervisor scope management

The three-file guideline is a **planning signal, not a worker permission limit**.
Neither execution nor verification tools receive a new file-count restriction.

## Decisions

Every executor and independent verifier gets an inspection-only supervisor scope
review before launch, including existing queued tasks and resumed attempts. The
supervisor assesses implementation scope and verification scope separately:

- **Focused:** one bounded outcome and its checks.
- **Cohesive:** a larger, coupled change that should remain together, including
  necessary callers, types and tests.
- **Broad:** independently deliverable outcomes that require an ordered split.
- **Unknown:** insufficient evidence; the supervisor must not invent breadth.

More than three edits calls for a coupling explanation, not an automatic split.
Reading many files to find one defect, running a full test suite, and generated
test output are distinguished from migrating many unrelated components.

Each worker also has an independent live scope-review lane. It can run while the
ordinary supervision loop is waiting for a verifier. Successful read/edit targets,
in-flight tools, opaque shell commands, current reasoning and journal evidence
inform the assessment. Counts are lower bounds, not a filesystem audit: shell,
MCP, aliases and generated side effects cannot be counted reliably from filenames.
The supervisor can inspect targeted inventories and current changes to resolve
uncertainty. It is not asked to read the entire repository before decomposing it.

Live reviews require fresh activity and are rate-limited by the existing review
interval. First widening (over three observed edit targets or twelve read targets)
can receive an earlier review after thirty seconds. These thresholds schedule a
model assessment; they never authorize a split or deny an edit themselves.

## Replacement plans

A broad assessment must return a complete split plan with:

1. Original acceptance-criterion inventory and child coverage references.
2. Bounded implementation/check descriptions and progress-preserving handoffs.
3. Explicit prerequisite keys, validated and topologically ordered by code.
4. A final integration task after every slice, retaining the original required
   verification command intact.

Invalid plans are rejected in full, with one repair attempt. There is no silent
six-part truncation. Coverage references, required fields and dependency structure
are validated mechanically; the semantic adequacy of the criteria and decomposition
remains supervisor judgment, not something a file-count heuristic can prove.

The original task, reports, full durable journal, plan and criterion mapping are
archived under `scopeSplit:<task-id>:<claim-timestamp>` in queue metadata before
replacement. Child descriptions carry their assigned criteria and handoff. The
existing SQLite split transaction inserts all children at the parent's position,
shifts later work and transfers accumulated token usage to the first child.
Nothing rolls back workspace changes or marks unfinished work as verified.

Split children carry a `scopeSplit` marker in their task `region` field. They act
as ordered verification barriers even in continuous mode: later work cannot run
or be verified ahead of an unfinished split prerequisite. The markers survive
reloads and nested splitting without relying on an in-memory dependency graph.
In-flight workers affected by a split are cancelled using the existing generation
fences; late results cannot overwrite the replacement queue. Replacement workers
are explicitly told to inspect and reconcile the current diff before proceeding.

Preflight failure does not launch the old broad task. Live assessment failure
preserves current work and is journalled; later fresh evidence permits a retry.
Owner/task changes and stop/reset supersede in-flight scope decisions.

## Code and tests

`scopeEvidence`, `scopePrompt`, `scopePlan` and `scopeSupervisor` separate observation,
judgment, plan validation and scheduling. `orchestratorScope` applies plans. The
previous large orchestrator is split into typed lifecycle/worker modules, each
under 500 lines, sharing the existing state and generation-fencing protocol.

Run `npm run typecheck`, `npm run build:ext`, and
`node --test scripts/*.test.cjs`. Scope regressions use deterministic model doubles
and real SQLite; they do not claim to evaluate a live model's judgment quality.
