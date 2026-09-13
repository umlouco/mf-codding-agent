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
- The executor owns its development checks. The runtime still reserves existing
  test rewrites for supervisor repair; the prompt no longer simultaneously tells
  the executor to repair those files itself. Queue enforcement is unchanged.
- Reports retain the existing JSON completion schema. No live queue or stored
  history is rewritten by prompt generation.

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
