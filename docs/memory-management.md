# Memory retention fixes

The memory audit found an unbounded terminal reader after command timeout,
live-output blocks that could exceed their character limit, and references
from terminal caches into detached task DOM. These paths now release their
resources without forcing garbage collection in the shared extension host.

- Shell capture stops reading at timeout and retains at most 256 Ki characters
  of recent output, with a truncation notice. The user's terminal command keeps
  running. Normal command completion still drains trailing diagnostics.
- Queue terminals retain at most 120,000 characters and 400 blocks per open
  terminal, including a single continuous response. Closed or deleted task
  terminals release their buffers and DOM references; reopening fetches recent
  output from SQLite. Task reports and the durable journal are unaffected.
- Live polling selects activity fields and a running task ID, rather than
  loading complete task descriptions and reports five times per second.
  A 128-entry LRU reuses prepared statements for both supported SQLite drivers.
- Queue view teardown stops its timer and disposes subscriptions. Reattaching
  the queue replaces the old listener. Hidden views skip full state rendering,
  and concurrent role-model lookups are coalesced.
- Disposed core transports clear request handlers and notification callbacks.
  Completed live logs release tool metadata. The language-model proxy disposes
  cancellation sources on success and failure and closes connections on shutdown.

Run the regression checks with:

```powershell
node --test scripts/memory-lifecycle.test.cjs scripts/keepalive.test.cjs scripts/blocked-recovery.test.cjs scripts/ownership-recovery.test.cjs
npm run typecheck
npm run build:ext
```

The tests exercise large streams, late output after timeout, detached DOM,
repeated listener registration, statement reuse, model-start failures, and
SQLite polling with a large stored report. They establish bounded retention
for these paths; they do not measure total RAM inside a running VS Code session.
Chat history, active model requests, browsers, and external model servers still
have their own memory requirements.
