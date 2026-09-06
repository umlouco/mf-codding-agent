# Queue observations and recovery fixes

Observed over SSH on 192.168.10.210. Final snapshot: 2026-09-05 21:50 UTC.
Queue databases were opened with SQLite mode=ro. No running extension, queue
state, application code, or server model settings were changed.

| Workspace | Verified | Verifying | Pending | Current evidence |
| --- | ---: | ---: | ---: | --- |
| /var/www/html/public/ecm | 14 | 1 | 24 | Advanced from 13 verified during inspection; repeated context-limit handoffs on controller mapping. |
| /var/www/html/public/plugins | 27 | 1 | 21 | Same validator waiting on run_shell for 2h13m. |

## Findings and changes

- Context accounting added OpenAI-compatible cached tokens to prompt_tokens even
  though that provider includes cache hits in prompt_tokens. The guard now uses
  provider-aware accounting. Anthropic's separate cache counters still count.
  This defect can cause premature handoffs; it does not establish the cause of
  every historical context-limit event.
- Queue workers previously defaulted to a separate 32,768-token ceiling. They
  now inherit llm.maxContextTokens unless an explicit smaller queue cap is set.
  This repository's .vscode/settings.json uses 256,000 tokens, as requested for
  the user's 256K models. Existing explicit settings in other workspaces still
  take precedence. This is a configured threshold, not model-window discovery.
- A spawned shell can exit while its child retains stdout/stderr. Go's pipe
  readers then wait despite cancellation. WaitDelay bounds that drain, with
  actionable errors for servers and accurate timeout/cancellation reporting.
- The supervisor awaited independent validation inside its busy cycle. Repeated
  shell heartbeats prevented silence recovery forever. The watchdog now recovers
  a validator reporting a run_shell wait beyond the tool's ten-minute maximum,
  allowing a further minute of grace. It does not limit model reasoning time.
  Recovery records the failure before aborting and fences late reports/events.
- An unreadable supervisor response previously defaulted to START_VALIDATION,
  potentially interrupting unfinished implementation. It now preserves work and
  reports a supervision error for reassessment.
- Retry briefings omitted the previous worker's structured completion/validation
  report. They now carry reported changes, checks, and unfinished work, clearly
  distinguished from independent evidence.
- ECM had no recorded memory tool events in its task journal, despite a graph
  containing 40 nodes, 23 edges, 23 observations, and two lessons. Plugins had
  20 memory tool events and a graph with 54 nodes, 47 edges, no observations,
  and one lesson. These are recorded-call counts, not proof that no other client
  accessed memory. Execution and verification now retrieve relevant knowledge
  through the existing memory/search RPC before chat starts. The worker prompt
  no longer claims notes are its only persistent memory. The graph remains the
  durable knowledge store; queue reports carry immediate task handoffs.
- The earlier local fix passing the original client prompt to execution and
  verification remains included. Derived tasks must be compared with that intent.

## Verification

- 22 JavaScript queue regressions passed, including real worker-startup wiring
  with graph enabled/disabled, handoff preservation, invalid supervisor decisions,
  and watchdog recovery with late success/error results.
- TypeScript typecheck and extension/core Windows builds passed.
- Go agent, provider, and tools test packages passed on Windows.
- A cross-compiled tools test binary was run in a temporary directory on the Linux
  server. TestRunShellBoundsInheritedOutputPipes passed in 1.00 seconds; timeout
  and cancellation checks passed. The binary and directory were removed.

## Scope and remaining evaluation

These changes are local and have not been installed into the two live sessions.
They establish recovery and memory plumbing, not proof of autonomous delivery
quality. Automatic recall cannot supply knowledge that was never recorded; writing
useful graph observations still requires the worker to use memory_remember.
Full-request delivery auditing, systematic clarification handling, and persistent
cross-workspace observation remain separate work. The observations here are
snapshots, not a continuously running monitor.
