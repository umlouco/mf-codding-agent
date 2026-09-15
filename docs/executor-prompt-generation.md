# Executor prompt generation

The runtime now builds the executor's task payload in
`src/queue/executorPrompt.ts` and its Go system policy in
`core/internal/agent/prompt_executor.go`. Interactive coder, planner, and verifier
policies are unchanged.

- The original goal, current task, acceptance checks, split scope, retry feedback,
  and owner instructions are preserved. Task details precede historical context.
- Only explicitly marked generated observations are filtered. Selection uses
  task-specific terms (not the whole project goal), deduplicates observation text,
  ranks relevance with recency as a tie-breaker, and includes at most three
  800-character excerpts. These remain claims to confirm, not verified facts.
- Unmarked legacy notes remain intact: the generator cannot safely determine
  which were written by the owner. Such notes can still make prompts long and
  must be reviewed by the owner rather than silently discarded or migrated.
- Detailed browser guidance is included for browser/UI-related tasks or owner
  browser requirements, not merely because the wider goal mentions Playwright.
  This is guidance selection, not removal of tools or acceptance checks.
- Execution turns own source, existing tests, and configuration within their task.
  A dedicated supervisor test-repair turn owns only tests, fixtures, and test
  harnesses; an application or production-config change it needs becomes its own
  smaller task through a split. Validators and inspection-only reviews remain
  read-only; queue storage is protected.
- Reports keep the JSON completion schema. A turn that ends without
  READY_FOR_VALIDATION fails the task, and `completion.splitInto` lets the executor
  propose the smaller tasks that replace it. No live queue or stored history is
  rewritten by prompt generation.

Regression checks:

```text
node --test scripts/executor-prompt.test.cjs
cd core
go test ./internal/agent -run TestExecutorPrompt -count=1
```

The TypeScript tests invoke the real `executeTask` entry point with a captured
model transport; Go tests render the real `BuildSystemPrompt`. These establish
prompt content, size budgets, and wiring, not improved live-model accuracy.
Rebuild the extension and core, then restart/reload the workspace extension to
use the changes. Existing conversations retain previously supplied prompts.
