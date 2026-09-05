# Prompt review for less capable coding models

Reviewed the core system prompt and handoff, queue planning/expansion/editing,
execution, verification, progress supervision, retry/format repair, CLI role
instructions, and documentation generation. Changes are model-independent;
no live model benchmark has been run.

## Findings and changes

| Priority | Finding | Change |
| --- | --- | --- |
| High | Queue examples used invalid JSON: pipe-separated alternatives, numeric placeholders, multiline strings, and an extra closing brace in the executor prompt. | Valid JSON examples; permitted enum values explained outside the examples. Tests parse rendered examples from production prompt paths. |
| High | A verifier could change its own test harness, including when a task said not to modify files. | Verification instructions prohibit source, fixture, assertion, and test edits. Harness problems return to the executor. Normal generated test output remains allowed. |
| High | Retry prompts treated repeated failure as evidence that the requirements must be wrong. | Recovery distinguishes code defects, invalid tool calls, environment problems, missing evidence, and excessive scope. Acceptance criteria must survive rewrites and splits. |
| High | The executor lacked a concrete sequence for producing and checking a change. | Inspect implementation/tests, confirm APIs, make a focused change, check behavior and boundary cases, inspect the diff, then report observed results. |
| Medium | Tool failures and serialized browser results could be mistaken for application defects. | Explicit browser return example; preserve supplied verification scripts; diagnose invocation errors before changing application code. |
| Medium | The core handoff requested prose even when the queue expected JSON. | Preserve the task's output format and report incomplete work in the appropriate status fields. |
| Medium | The CLI role suffix described every non-supervisor as a planner. | Separate executor instructions and clarify read-only planning. |
| Medium | Documentation generation received only filenames but requested implementation details. | State evidence limits and prohibit invented commands, configuration, and module behavior. |

Shared queue guidance lives in `src/queue/prompts.ts`. The Go system prompt also
contains the essential coding workflow because interactive editor turns do not
receive the queue's instructions. Existing tool schemas and runtime guards remain
necessary: prompt instructions do not enforce read-only access or guarantee truth.

## Validation and measurement

`node --test scripts/queue-retry.test.cjs` exercises retry transitions and renders
worker/recovery prompts using fake model responses. It parses their JSON examples
and checks that completion/verification examples work with the real parsers.
TypeScript checking, extension/core builds, and relevant Go tests check integration.
These checks establish format and wiring correctness, not improved model accuracy.

For a live comparison, use the same model file/version, quantization, chat template,
sampling settings, context limit, tool set, and initial checkout for both prompt
versions. Use separate disposable workspaces and repeat each case several times:

- A small bug with a known failing regression test.
- A multi-file change requiring existing APIs and public behavior to be preserved.
- Browser conditionals with a supplied script and four independently asserted states.
- A malformed selector with correct production code, to detect unnecessary code edits.
- An unavailable test dependency, where the correct outcome is incomplete verification.
- A task interrupted after useful edits, then resumed with a fresh attempt budget.

Grade changes using independent checks kept outside the worker's editable workspace.
Record first-attempt correctness, correctness after recovery, false PASS reports,
unrelated changes, repeated tool failures, malformed final JSON, tokens, and elapsed
time. Report per-case outcomes as well as aggregate rates. The supplied execution
sample names Qwen3-Next-80B-A3B-Instruct-GGUF; confirm the intended Qwen3-Coder-Next
configuration separately when running that comparison.
