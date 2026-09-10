# Headless runtime and external TDD

Build with `npm run build:core`, `npm run build:headless`, and
`npm run build:ext`. No VS Code installation or extension activation is required
to load `out/headless.cjs` in Node 22.13 or newer.

## Production boundaries

- `runtime/coreTransport.ts` owns subprocess lifetime and JSON-RPC. Both the
  editor's `CoreClient` adapter and the standalone role runner use it.
- `runtime/roleRunner.ts` accepts explicit configuration instead of reading
  editor settings or secret storage. Planner uses Claude Code CLI; executor
  and supervisor use separate Go core processes and independent contexts.
- `nativeFS: true` opts standalone hosts into the Go core's existing native file
  tools. Default editor behavior still uses buffer-aware editor RPC.
- `runtime/queueImport.ts` snapshots SQLite including committed WAL data without
  running migrations on the source. Existing destinations are never overwritten.
- `runtime/queueRunner.ts` operates on the shared production `TaskQueue` with an
  injected role runner. It plans, executes, independently verifies, supervises,
  and feeds observed failure back into the next attempt.

`prepareReplay(queue)` is an explicit, one-time operation for a **copied** queue.
It records every original contract and historical status, then resets every row
for fresh execution, including previously verified and paused rows. Keep the raw
snapshot separately. Never call it on a source or active production queue.

The first unfinished task gates all later tasks. A failed review, malformed
verdict, endpoint failure, cancellation, or exhausted retry budget does not mean
completion. Original IDs, order, text and acceptance criteria are checked before
and after every turn. Neither deletion nor contract rewriting is an improvement.
Both independent verification and supervisor approval must establish PASS.
Tasks with a required command additionally need a host-recorded successful exit
from `createCommandRunner`; model approval cannot substitute for that receipt.
This runner uses the core's portable shell directly, without an LLM. Explicit
`sourceRoot` relocation is recorded alongside the unchanged original command.
Commands that fail, time out, cannot be parsed, or lack a command runner leave
the task unfinished even when both models claim PASS.

## External tests and fixtures

Tests, fake processes, regression runners, source snapshots, and replay reports
belong to a separate sibling workspace, not this extension repository or VSIX.
The headless build rejects any transitive `vscode` import. The extension package
continues to include only its production entry point and runtime binaries.

For this checkout the external workspace is `../mf-codding-agent-tests`:

1. `node ../mf-codding-agent-tests/run.cjs headless`
2. `node ../mf-codding-agent-tests/run.cjs legacy`
3. `node ../mf-codding-agent-tests/run.cjs go`

Its `prepare-replay.cjs` imports Parnassus into the ignored local
`.mfagent/replay/` directory; `run-replay.cjs` drives the production API and writes
external reports. It uses an exclusive runner lock to prevent concurrent hosts.
An interrupted host must be confirmed stopped before recovering its stale lock
or RUNNING state. Do not clear those while a process is still active.

The local replay configuration selects Claude CLI `sonnet`,
`Qwen3-Next-80B-A3B-Instruct-GGUF` for both executor and supervisor at
`https://SRV-STAILLM01.connexall.com/api/v1`, following the updated supervisor
selection. Roles still run in separate contexts; supervisor remains read-only.
No fallback is configured.
Credentials are resolved via named environment variables, not committed settings.
Connexall knowledge MCP servers are configured locally; unavailable domain sources
or live test environments must be reported rather than replaced with invented evidence.

Local executor and supervisor turns have no whole-turn timeout by default. Each
model response may be silent for 35 minutes before the stream idle guard fires.
The old `turnTimeoutMs` applies to the Claude planner only; local-specific settings
are `localTurnTimeoutMs` (0 = unlimited), `localModelIdleSeconds`, and
`localModelAvailabilityWaitMs`. Connection startup is allowed 35 minutes too,
with cancellable TCP probes that never submit duplicate inference requests.
A missing TCP connection is logged separately from a model that is computing.

The source fixture is an isolated filesystem copy, **not an OS security sandbox**.
Do not grant untrusted tasks access to production credentials. Absolute source
paths must be explicitly mapped to the fixture before running task commands;
the original acceptance text is retained unchanged for auditing.
