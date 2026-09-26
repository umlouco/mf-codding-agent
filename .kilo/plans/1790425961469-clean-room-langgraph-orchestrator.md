# Clean-room LangGraph orchestrator (Go → TypeScript)

## Goal

Rebuild MF Agent as an all-TypeScript/Node system whose agent orchestration is a
LangGraph.js graph and whose durable task list is an OpenClaw/Hermes-style queue,
with a fail-safe daemon that survives a crashed extension. Delete Go.

**Acceptance (the reason for this work):** the goal *"create a Pac-Man game in
JavaScript and test it in the browser"* completes end-to-end on `deepseek-flash`
in **under 15 minutes** with **no more than ~60 model round-trips** (today:
80+ min, ~467 round-trips, 19 detached sessions, 26 s of actual tool time).

## Non-goals

- Preserving the current `core/` Go behavior 1:1. This is a rip-and-replace.
- Backwards-compatible queue DB. Existing `.mfagent/queue.db` files are not migrated.
- Marketplace/VSIX identity decisions (deferred; see Open questions).

## Locked decisions

| Decision | Choice |
|---|---|
| Orchestration | LangGraph.js `StateGraph` + durable SQLite checkpointer |
| Language | TypeScript/Node only; **delete Go** (`core/`, `bin/`, Go build steps) |
| Sequencing | Rip and replace, clean room in a **new folder**, old repo frozen then deleted |
| Task model | Durable queue ledger (OpenClaw) + dependency DAG state machine (Hermes) |
| Small jobs | ONE executor session with a persistent **todo list**; no per-phase/task fan-out |
| Subagents | Context quarantine only; isolated context; **no nested fan-out** (depth ≤ 1) |
| Completion | Deterministic gate over **recorded evidence** (Hermes completion contract) |
| Fail-safe | Node daemon as OS service + **independent OS-scheduled health check** |
| Providers | LangChain `BaseChatModel` adapters, incl. Claude Code / Codex CLI, no API key |

## Target architecture

```
┌──────────────────────────────┐        ┌───────────────────────────────────────┐
│ VS Code extension (thin)     │  IPC   │ mfagentd  (Node daemon, OS service)   │
│  - UI, editor tools bridge   │◄──────►│  - owns queue DB (SQLite, WAL)         │
│  - starts/observes daemon    │        │  - dispatcher tick + health loop       │
└──────────────────────────────┘        │  - spawns/supervises worker processes  │
                                         │  - heartbeat row + file                │
        OS health check (independent)    └──────────────────┬────────────────────┘
        Windows Task Scheduler / systemd timer / cron       │ spawn
        runs: mfagentd health --fix                          ▼
                                         ┌───────────────────────────────────────┐
                                         │ mfagent-worker (Node, per task)       │
                                         │  - LangGraph.js graph execution       │
                                         │  - providers, tools, todo list         │
                                         └───────────────────────────────────────┘
```

Why this shape: LangGraph has no Go implementation, so the graph is TS. Node cannot
match Go's single static binary, so the always-on resilience lives in (a) a Node
daemon installed as an OS service and (b) a **separate** OS-scheduled health job that
can restart the daemon — the health job is independent of both the daemon and VS Code,
which is what satisfies "restart even if all extension code crashed".

## New repo layout (clean room)

Create `C:\Users\Mario Flores\Documents\mfagent-next` (sibling, so no legacy build
config leaks in). pnpm workspaces:

```
mfagent-next/
  packages/
    shared/          types, SQLite schema + DAO, config, secret store, logging
    orchestrator/    LangGraph graphs, state, checkpointer, tools, providers
    daemon/          mfagentd: queue, dispatcher, supervisor, control API, health
    worker/          mfagent-worker entrypoint (runs one graph run per task)
    extension/       VS Code extension (thin client + editor-tool bridge)
  installers/
    windows/         service install + Task Scheduler health job
    linux/           systemd unit (or --user + linger) + timer/cron health
  test/              integration + crash tests
```

Archive `C:\Users\Mario Flores\Documents\mf-codding-agent` when parity passes; delete
`core/`, `bin/`, `mfcore.exe`, Go build scripts, and the Go bundling in `runtime/`.

## Data model (SQLite, WAL)

Keep OpenClaw's separation of **execution** vs **delivery**, and Hermes' state machine.

```sql
tasks(
  id, seq, title, body, assignee,
  status,              -- triage|todo|ready|running|blocked|review|done|archived
  execution_status,    -- queued|running|succeeded|failed|timed_out|cancelled|lost
  delivery_status,     -- pending|delivered|blocked
  claim_lock, claim_expires_at, worker_pid, worker_started_at,
  wallclock_budget_ms, max_attempts, consecutive_failures, model_override,
  workspace_kind, workspace_path, parent_flow_id, created_at, updated_at
)
task_links(parent_id, child_id)            -- dependency DAG; todo→ready promotion
task_runs(id, task_id, attempt, started_at, ended_at, outcome, error, usage_json)
task_events(id, task_id, actor, kind, message, at)
task_evidence(id, task_id, run_id, kind,   -- command|test|browser|diff|file
              command, exit_code, status, summary, payload_json, at)
flows(id, goal, status, created_at, ended_at)
checkpoints(...)                            -- LangGraph SQLite checkpointer tables
heartbeat(id, at, pid, note)                -- daemon liveness for the health job
```

## Orchestration graph (`packages/orchestrator`)

`StateGraph` with `Annotation.Root` state. Nodes:

- `intake` — read goal/contract; decide **sizing**: `inline` (one session) vs `queued` (durable fan-out). Small/self-contained goals go `inline`.
- `plan` — emit a **todo list** and, only for `queued`, coarse cards into the ledger. Cap phases/tasks by workspace size (a 4-file workspace must not produce 11 phases).
- `execute` — one executor session per task. The **planning-tool middleware** owns the todo list in-session; items are checked off in state, not new sessions.
- `delegate` — optional `task()` subagent call for context quarantine only. Enforced `depth = 1`; subagent gets a reduced prompt and a minimal tool set.
- `gate` — deterministic completion contract: read `task_evidence`; `done` requires all required evidence present and green. Missing/pending/failed ⇒ block, not retry-into-the-same-wall.
- `recover` — reclaim/requeue, circuit breaker (block after N consecutive failures), stale-claim handling.
- `summarize` — structured handoff (`summary`, `metadata`, `evidence`, `artifacts`).

Durability: compile with a SQLite checkpointer so a crashed worker resumes the same
run; the queue ledger remains the source of truth for lifecycle.

### Planning tool (the core perf fix)

Implement the Deep-Agents/Claude-Code pattern: a `writeTodos`/`updateTodos` tool whose
list lives in graph state. For an `inline` goal the executor plans, edits, runs the
browser check, and completes **inside one session** — the extension no longer creates a
session per phase, a scope-preflight turn per task, or a separate browser-driving
"Verify …" task per phase.

## Providers (`packages/orchestrator/providers`)

Each is a LangChain `BaseChatModel` (streaming + tool calling):

- `OpenAICompatibleChatModel` — DeepSeek, Lemonade, OpenRouter, OpenAI, any `/v1`.
- `AnthropicChatModel` — native Messages API.
- `ClaudeCliChatModel`, `CodexCliChatModel` — spawn the CLI, map turns to messages, **no API key**.
- `VsCodeLmChatModel` — `vscode.lm` via a loopback proxy (extension host only).
- `EmbeddingModel` — embeddings role (e.g. Lemonade `embed-gemma-300m-FLM`).

Keep the role registry (coding, vision, embedding, planner, supervisor, executor,
validator, supervisor-repair); each graph node resolves its own profile+model+effort,
so "different LLM providers for different agents" is preserved.

## Tools parity (Go → TS)

| Capability | Action |
|---|---|
| fs read/write/edit, shell, list/glob/grep | Reimplement in TS |
| Browser / Playwright | Use Playwright npm directly (drop Go browser bridge) |
| MCP client | Official MCP TS SDK |
| Workspace scan → regions | Reimplement deterministic scanner in TS |
| Memory / cognition graph + reducer | Reimplement in TS over SQLite + embeddings |
| Layout/visual evidence | Playwright screenshots + TS diff (drop Go binary) |
| Skills loader | Reimplement in TS |
| Queue MCP server | Reimplement in TS |
| WordPress-specific skills | Keep only if still required (Open question) |

## Fail-safe daemon + health check

- `mfagentd` (Node): opens the queue DB with a single-writer lock, runs the dispatcher
  tick (reclaim stale claims by TTL → probe worker pid → promote `todo→ready` →
  atomic claim via SQLite transaction → spawn `mfagent-worker` → enforce concurrency),
  and writes a `heartbeat` row/file every few seconds. Exposes a small local control
  API (start/pause/status/stop) for the extension and CLI.
- **Independent health job** (separate OS process, not part of the daemon):
  - Windows: Task Scheduler task every 5 min → `mfagentd health --fix`.
  - Linux: systemd timer (or `*/5 * * * *` cron) → `mfagentd health --fix`.
  - `--fix`: if heartbeat stale or process missing → restart service; reclaim `running`
    tasks with expired claims; re-arm the dispatcher; run `PRAGMA integrity_check`.
- Install strongest-available: systemd system unit / Windows service when elevated;
  otherwise `systemd --user` + `loginctl enable-linger` / per-user Task Scheduler. The
  health job is registered **separately** so it can restart the daemon itself.
- Secrets: the daemon is outside VS Code, so replace `SecretStorage` with an OS keychain
  (keytar) or an encrypted file whose key is held in the OS keychain. Never plaintext.
- Isolation: the extension is a client. If VS Code closes or the extension host crashes,
  the daemon and health job keep the queue running.

## Ordered task list

**Phase 0 — scaffold**
1. Create `mfagent-next` pnpm workspace with `shared`, `orchestrator`, `daemon`, `worker`, `extension`.
2. CI: typecheck, unit tests, Windows + Ubuntu matrix.
3. Implement `shared`: config, logging, SQLite DAO + migrations, secret store.

**Phase 1 — durable queue + daemon (no LLM yet)**
4. Queue DAO and state machine (`triage…archived`, execution/delivery split, links).
5. Dispatcher tick: reclaim (TTL) → crash probe → promote → transactional claim → spawn → concurrency.
6. `mfagent-worker` entrypoint stub; `task_runs`, `task_events`, `task_evidence`.
7. Heartbeat + control API; single-writer lock.
8. Circuit breaker, wall-clock budget, max attempts.

**Phase 2 — fail-safe install**
9. `mfagentd health --fix` command.
10. Windows service + Task Scheduler health task; Linux systemd unit/linger + timer.
11. Crash tests: kill daemon mid-run; kill extension; assert self-restart + resume.

**Phase 3 — LangGraph orchestrator + providers**
12. State schema, SQLite checkpointer, graph skeleton (`intake/plan/execute/gate/recover/summarize`).
13. Provider adapters (OpenAI-compatible, Anthropic, Claude CLI, Codex CLI, vscode.lm, embeddings) + role registry.
14. Planning tool middleware (todo list in state).

**Phase 4 — tools**
15. fs/shell/search tools; Playwright tools; MCP client; skill loader.
16. TS workspace scan → regions; memory/cognition; visual evidence.

**Phase 5 — inline fast path + completion gate**
17. `inline` sizing path: one executor session for small goals; no phase/task fan-out.
18. Deterministic completion gate over `task_evidence`; required-evidence contract.
19. Subagent `task()` with enforced depth ≤ 1 and reduced prompt/tools.

**Phase 6 — extension client**
20. Thin extension: control the daemon, render queue/evidence, bridge editor tools as graph tools.
21. Bundle with esbuild; no Go binary.

**Phase 7 — remove Go**
22. Delete `core/`, `bin/`, Go build scripts, Go runtime bundling; archive the old repo.

## Validation

- **Perf gate (primary):** run the Pac-Man goal via the daemon on `deepseek-flash`.
  Assert wall clock < 15 min and round-trips ≤ ~60; record a baseline report.
- **Crash/recovery:** `kill -9` the daemon during a run → health job restarts it and the
  run resumes; kill the extension host → daemon unaffected; corrupt heartbeat → `--fix` repairs.
- **State machine unit tests:** reclaim, promote, claim race, circuit breaker, budgets, gate.
- **Provider tests:** each adapter, including CLI-without-key, with a recorded fake server.
- **Cross-platform install tests:** Windows Task Scheduler and Linux systemd/linger.
- **No-regression check:** a multi-day queued goal survives daemon restarts and host reboot.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Node daemon less crash-proof than a Go binary | OS service + independent health job + heartbeat; checkpointed runs |
| LangGraph.js API churn | Pin versions; isolate graph behind the orchestrator package |
| CLI provider fidelity (Claude/Codex, no key) | Dedicated adapters + recorded-fixture tests |
| SQLite multi-process contention | Single-writer daemon lock; WAL; short transactions |
| Secret storage outside VS Code | OS keychain (keytar) or keychain-wrapped encrypted file |
| Reimplementing Go tools is large | Phase 4 is incremental; ship each tool behind a parity test |

## Open questions

1. Keep the WordPress skill pack, or drop it in the clean room?
2. Keep the current VSIX/extension identity, or publish the clean room under a new name?
3. Elevated (system) service where possible, or strictly user-level with linger? Plan
   assumes strongest-available; confirm if a shared host must forbid elevation.
4. Exact `@langchain/langgraph` / `deepagents.js` versions to pin (verify at Phase 0).
