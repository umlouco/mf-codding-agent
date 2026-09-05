# Autonomous runs with local models

Queue workers now default to 24 tool rounds per turn and a 32,768-token context
ceiling. These are conservative application defaults, not benchmark results for
a specific model or quantization. Configure `mfagent.queue.maxContextTokens` at or
below the context configured on your inference server. The smaller positive value
of this setting and `mfagent.llm.maxContextTokens` wins.

`mfagent.queue.workerMaxRounds` controls executor and independent verifier turns.
At a limit, the core requests a handoff report and the supervisor automatically
decides how to continue, rewrite, split, or verify the work. Disk changes survive.
A stopped verification turn is INCOMPLETE, even if its response claims PASS.
These limits bound individual turns, not total retries or total run time.

Workers distinguish task deliverables from queue reports. A task requesting a JSON
analysis writes that artifact to disk; its final response still carries the queue's
completion or validation envelope. Reports should stay under 1,200 words, with
concise evidence and artifact paths instead of full source files. Valid JSON wrapped
in fences or surrounding prose is accepted without another model call. Truncated
or malformed JSON is not repaired into passing evidence.

An independent PASS must include implementation and behavior evidence, a summary,
passing checks with evidence, and no unfinished checks. The supervisor cannot mark
a task VERIFIED when this evidence floor fails. This checks report consistency;
it does not prove that reported observations are true or replace runtime tests.

The planner is instructed to group small inspections into behavioral outcomes and
inspect persistence, validation, and existing tests before implementing dependent
UI changes. Planning quality still depends on the model following these instructions.

Validation: `node --test scripts/queue-retry.test.cjs`, `npm run typecheck`, and
`npm run build:ext`. Real inference throughput and task completion quality must be
measured against the configured local endpoint; this change does not include a
Qwen3-Coder-Next Q6_K / Strix Halo benchmark.

The full original queue-generation prompt is saved under `goal` in `queue_meta`.
Every supervisor review and recovery turn receives that saved text without the old
2,000-character truncation, including live task/validation rewrites, fallback rewrites,
escalation/splitting, and verdict reformatting. Recovery prompts require comparing
changes against the original constraints. This does not modify the saved prompt.
Older queues without a recorded goal explicitly report that absence.
