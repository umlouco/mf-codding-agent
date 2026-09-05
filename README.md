# MF Agent

A lightweight coding agent for VS Code 1.136 and newer. Clean-room — no notebook
support, no ecosystem you don't use — and built on the editor's own modern APIs:
the models VS Code offers through `vscode.lm` are the default place its agents
run, and the MCP servers the editor manages are shared in both directions.

Built around four things: **graph memory that survives across sessions**, **strong
editing tools**, **POSIX commands that work natively on Windows**, and **real browser
testing**. Plus MCP, so you can plug in anything else, and an autonomous task
queue — planner, executors, verifiers and a supervisor loop — brokered through a
SQLite database you can watch live.

The extension host stays a thin shim: spawn the core, pump JSON-RPC, render the
webviews, and adapt the editor's APIs for a process that cannot call them.
Everything real happens in a single compiled Go binary.

---

## Why it's built this way

VS Code only loads JavaScript in its extension host, so a shim is unavoidable. The
shim is kept as small as it can be: spawn the core, pump JSON-RPC, render a webview.
The agent loop, tools, memory, MCP clients and browser driver all live in Go and ship
as one static binary with no runtime dependencies — the same pattern `gopls` and
`rust-analyzer` use.

```
┌─ VS Code extension host ──────────────────────────────────┐
│  extension.ts    commands, gating                         │
│  panel.ts        webview chat                             │
│  queue/          task store, orchestrator, supervisor     │
│                  loop, live webview (200 ms SQLite poll)  │
│  llm/router.ts   which transport carries a role           │
│  llm/lmProxy.ts  vscode.lm behind an OpenAI endpoint      │
│  mcpBridge.ts    MCP servers ⇄ VS Code, lm.tools ⇒ core   │
│  core.ts         JSON-RPC over stdio                      │
└──────────────┬────────────────────────────────────────────┘
               │ newline-delimited JSON-RPC 2.0
┌──────────────▼──────────────────────────────────────────┐
│  mfcore  (single static Go binary)                      │
│                                                         │
│  agent loop ── tools ── graph memory (SQLite)           │
│       │         ├─ MCP clients                          │
│       │         ├─ editor tools ──▶ lm/invokeTool, host │
│       │         └─ browser (CDP)                        │
│       └─ LLM: vscode.lm via the proxy / Anthropic /     │
│               any OpenAI-compatible endpoint            │
└─────────────────────────────────────────────────────────┘
```

---

## Two agents, one composer

The selector next to the message box decides who answers.

**Coder** is the chat you already know: one long-lived core, one conversation, tools
that read and edit the workspace as you talk. This is the default, and every editor
command (*Ask About Selection*, *Edit Selection*, *Explain Problems*) goes to it
regardless of what the selector is set to — those are questions about the
conversation.

**Planner** does not join the conversation, and it does not try to plan the whole
project in one turn either. The workspace is scanned first — a deterministic,
non-LLM pass that splits it into regions no larger than
`mfagent.queue.maxFilesPerRegion` files each, so the size of that scan never
depends on a model's judgement of its own context budget. A throwaway core on the
**Queue · Planner** model then reasons over that compact region list (paths, file
counts, languages — not file contents) and scopes a handful of **phases**, which
land in the **Task Queue** as their own kind of row. What you see in the chat is
the scan, then the phases. If the queue already has tasks you are asked whether to
replace them or append.

Nothing starts running on its own. Review the phases in the Task Queue view and
press **Start**: each phase is claimed the same way a task is, explored within its
own region by a fresh throwaway core, and expanded into the concrete, verifiable
tasks that carry it out — so the same crash-safe claim/cron machinery that runs
the autonomous execution covers planning a large codebase too, and a phase whose
region turns out to still be too big splits further by re-scanning it, rather than
asking a model to size its own work.

---

## Graph memory

Most agents forget everything between sessions, or bolt on a vector store that
returns semantically-similar-but-unrelated chunks. This uses a persistent property
graph instead, in three tiers:

| Tier | What it holds | How it's queried |
|---|---|---|
| **Observations** | Append-only facts attached to an entity | Full-text |
| **Retrieval** | FTS5 seeds, then one hop across the graph | `memory_recall` |
| **Substrate** | Typed nodes and typed, weighted edges | `memory_trace` |

The one-hop expansion is the part that matters. Searching *"Stripe"* returns
`StripeGateway` — and also the `exponential-backoff-policy` decision connected to it,
which shares no vocabulary with the query and no keyword or vector search would find.
An entity reached from two different seeds outranks one reached from a single seed.

Entities are typed (`File`, `Symbol`, `Module`, `Decision`, `Bug`, `Requirement`,
`Endpoint`, `Table`, …) and so are relations (`depends_on`, `calls`, `defines`,
`fixes`, `supersedes`, `part_of`, …). A closed vocabulary is what keeps the graph
queryable — an open label space degrades into a bag of strings.

Storage is one SQLite file per workspace at `.mfagent/memory.db`, via a pure-Go
driver. No server, no cgo, nothing to install.

Inspect it any time with **MF Agent: Show Graph Memory**.

---

## Tools

**Editing** — `read_file`, `write_file`, `edit_file`, `multi_edit`, `list_dir`.
Edits are exact-string replacements that must match uniquely, so a change is
reviewable rather than a whole-file rewrite. Writing a file the agent hasn't read, or
that changed on disk since it read it, is refused. CRLF mismatches are detected and
explained rather than failing silently.

**Search** — `glob` (with `**`) and `grep` (RE2, with `lang` shorthands for
`php`/`ts`/`js`/`go`/`delphi`). Both skip `node_modules`, `vendor`, `__history` and
friends, which is what makes them fast enough not to need a native ripgrep.

`grep` answers "how many" and "which ones" as well as "where", so those questions
don't have to be rebuilt as a shell pipeline. `output_mode` selects matching lines
(default), the list of matching files, or a per-file count with an exact total that
ignores the result limit. `capture` returns one regex group from every match on
every line rather than the whole line, and `unique` deduplicates and sorts the
result, reporting the distinct count alongside the raw one:

```
grep pattern="(\w[\w.]*) in '(src\\merge-package\\[^']*)'"
     capture=1 unique=true output_mode="count"

  → total: 182 matches across 3 file(s)
    distinct: 170
```

That gap between 182 and 170 is the sort of thing that takes four disagreeing
`grep | sort | uniq | wc` pipelines to notice, and one call to state.

**`unix`** — a POSIX shell interpreted natively in Go: full `sh` syntax — pipes
(`|`), `&&` and `||`, `for`/`while`/`if`, command substitution, globbing,
here-documents and redirection (`>`, `>>`) — identical on Windows, macOS and Linux
with no WSL, no Git Bash, no busybox.

The utilities behind that syntax come from whichever implementation is better. On
Linux and macOS the host's own `sed`, `grep`, `awk`, `find`, `ls` and friends
answer, so the complete utility is available; on Windows, where none is installed,
Go builtins cover a documented subset of each — the tool description carries their
exact usage, and a builtin that is asked for something it does not implement says
so and prints what it does accept. `MFAGENT_PORTABLE_UTILS=1` forces the builtins
everywhere. `mkdir touch rm cp mv tee` are always the Go versions, and redirections
always go through the workspace guard, so neither can write outside the workspace.
Anything with no Go implementation at all — `composer`, `npm`, `go`, `git` — runs on
the host shell, so builds compose into the same script.

```
grep -rn TODO src | wc -l
cat composer.json | grep require
find . -name "*.pas" -type f | sort > delphi-files.txt
```

**`run_shell`** — the real shell (PowerShell on Windows, `sh` elsewhere) for builds,
tests, package managers, compilers and git.

It runs in a **real VS Code terminal** when your VS Code offers shell integration —
the same terminal you'd type in, so it inherits your configured shell and profile:
your `PATH`, your nvm/pyenv shims, your active virtualenv, your git credential
helper, your proxy variables. "Works in my terminal, fails from the agent" is
usually one of those, and this removes the class. It also means a long build scrolls
in a tab you can watch, interrupt with Ctrl-C, and scroll back through afterwards,
instead of resolving into whatever the model chose to quote.

If shell integration isn't available, the agent spawns the shell itself and says so
rather than guessing: a command whose exit status the terminal couldn't report comes
back as `exit=unknown`, never as success. Turn it off with
`mfagent.shell.useTerminal`. Background queue workers always spawn their own shell —
several unattended agents sharing one visible terminal would interleave their output
and steal your focus.

**`project_info`** — detects languages, tooling, npm/composer scripts, and Delphi
`.dpr`/`.dproj` projects.

**Browser** — `browser_open`, `browser_elements`, `browser_click`, `browser_fill`,
`browser_eval`, `browser_wait`, `browser_screenshot`, `browser_console`. Drives real
Chromium over the DevTools Protocol. `browser_elements` returns interactive elements
with ready-made CSS selectors, so the agent isn't guessing them; `browser_console`
returns errors and uncaught exceptions, so "it compiles" and "it works" stay
different claims. Screenshots appear inline in chat.

The browser profile is persistent, at `.mfagent/browser-profile/`, so a login done in
one task is still valid in the next — the task queue spawns a fresh core per task, and
without this every auth-gated task would have to log in again. For the session to
actually survive, the login must set a *persistent* cookie: on a WordPress login, tick
"Remember Me", or the cookie is a session cookie that is never written to disk. Delete
the profile directory to sign out.

**Playwright** — `playwright_status`, `playwright_test`, `playwright_install`. Runs the
project's *own* suite, rather than a second automation stack: `playwright_test` returns
which specs passed and failed with the assertion, the `file:line`, and any screenshot or
trace left behind, so a failure arrives ready to act on instead of as a wall of output.
Narrow a run with `spec` or `grep` while iterating. The browser tools above stay on CDP
and need no Node, so a server without Playwright still has working browser tools.

**Memory** — `memory_recall`, `memory_trace`, `memory_remember`.

**MCP** — every tool from every connected server, namespaced `mcp__<server>__<tool>`.

---

## Permissions

**There are none. The agent runs everything it decides to run.**

Every edit, command and deletion happens the moment the model calls the tool —
no confirmation prompt, no approval step, nothing to click. This is deliberate:
an agent that stops every few seconds is an agent you supervise instead of one
that works, and a prompt you answer fifty times an hour is one you stop reading
by the tenth. If you want a machine that asks first, this is the wrong tool.

What you get instead is **visibility, not consent**. Each call appears in the
chat as it runs, with a one-line summary of what it is doing — `write_file ·
Write src/app.ts (128 lines)`, `unix · runs rm — rm -rf build` — written by the
tool itself rather than inferred from the raw arguments. Shell commands run in a
[real VS Code terminal](#tools) you can watch and interrupt with Ctrl-C.

What still constrains the agent:

- **Workspace confinement.** Every path a tool resolves, including shell
  redirections and the `mkdir`/`rm`/`cp`/`mv`/`tee` builtins, goes through a
  check that refuses anything outside the workspace root — `..`, absolute paths
  and symlinks pointing out of the tree included. A mistake is confined to this
  project. Everything *in* this project is reachable.
- **A small denylist** of catastrophic literals (`rm -rf /`, `mkfs`, fork bombs).
  A denylist of strings is a guardrail against a slip, not a security boundary,
  and it should not be trusted as one.
- **Read-before-write.** Overwriting a file the agent hasn't read, or that
  changed on disk since it read it, is refused.
- **Git.** Work on a branch and commit often. This is the real undo.

Use this on code you have under version control, and read what it does.

---

## Setup

Requires VS Code 1.136 or newer to run, and Go 1.24+ and Node 20+ to build.
Nothing in the extension carries a fallback for an older editor: the `vscode.lm`
and MCP definition-provider APIs it is built on are assumed to be there.

```bash
npm install
npm run build          # builds the Go core, then bundles the extension
```

Then press <kbd>F5</kbd> in VS Code to launch the Extension Development Host, or
`npm run package` for a `.vsix`.

### Providers and models

Run **MF Agent: Settings — Providers & Models** from the command palette (or the gear
on the Task Queue view). Everything to do with LLMs lives there, not in
`settings.json`.

**Providers.** Start with **VS Code Language Models**: the models the editor
itself offers through `vscode.lm` — GitHub Copilot's, and any other vendor an
installed extension registers — with no key, endpoint or account beyond the one
VS Code already has. VS Code asks once for consent the first time a model is
used; **Test connection** on that provider triggers the prompt. The Go core
cannot call editor APIs, so the extension runs a loopback proxy that presents
those models as an OpenAI-compatible endpoint (`src/llm/lmProxy.ts`), and every
tool — files, shells, browser, memory, MCP — works on them exactly as it does on
an HTTP provider. Token counts on those turns come from the model's own
tokenizer, since the API reports none.

Or pick from Anthropic, OpenAI, OpenRouter, Google Gemini, DeepSeek, Mistral,
Groq, xAI, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, Voyage, any
OpenAI-compatible endpoint, or the Claude Code CLI. Each one asks for the fields
it actually needs. You can keep several — an editor model, a hosted account and a
local server side by side.

**API keys** go to the OS keychain via VS Code's `SecretStorage`. Leave a key blank
to fall back to the provider's environment variable (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and so on).

**Models** are fetched from the provider, with context window, pricing and
capabilities where it publishes them. Nothing is hard-coded, so a model released
this morning shows up after **Refresh**.

**Roles** bind a provider and model to a job. This is model selection per task
type — the planner, supervisor and executor each get their own binding, and an
editor model is picked here like any other:

| Role | What it drives |
|---|---|
| Coding | Chat and code generation. Every other role falls back to it. |
| Vision | Image understanding — screenshots, mockups, diagrams. |
| Embedding | Vectors for hybrid graph-memory search. Never inherits: it needs a real embeddings model. |
| Queue · Planner | Turns a goal into a task list — from the sidebar or the chat's Planner. |
| Queue · Supervisor | Verifies finished tasks. Use your strongest model. |
| Queue · Executor | Does the work. A fast local model fits well. |

A role can borrow the Coding provider but override just the model, so a cheap
executor and a strong supervisor on one account do not need two profiles. It can
also override just the **reasoning effort** the same way — Minimal through Extra
High, plus Max on Anthropic — so a low-effort executor and a high-effort supervisor
can share one account and one model. This is sent as `reasoning_effort` on the
request, which OpenAI's own reasoning models and OpenRouter both understand
(OpenRouter treats it as shorthand for `reasoning: {effort}` and translates it for
whatever actually serves the model); a provider that has never heard of it either
ignores it or gets it silently dropped on retry, the same way an unsupported
`stream_options` already does.

**Export / Import** moves a setup between machines, with or without the keys.

### Project instructions

Drop an `AGENTS.md`, `CLAUDE.md`, or `.mfagent/instructions.md` in the workspace
root and the agent reads it into the system prompt on every session — repo-specific
conventions, where things live, what not to touch. Checked in that order, first
match wins; nothing is required and nothing merges, so pick one.

### MCP servers

```jsonc
{
  "mfagent.mcpServers": [
    { "name": "github", "url": "https://api.githubcopilot.com/mcp/" },
    { "name": "postgres", "command": "npx", "args": ["-y", "@bytebase/dbhub"] }
  ]
}
```

Both stdio and streamable HTTP transports are supported. Servers connect in parallel
at startup; one that fails is reported as a warning rather than blocking activation.

A server that needs an API key belongs on the settings page's **MCP Servers** tab
instead: the key goes to the OS keychain and is put back into the server's
environment (stdio) or headers (HTTP) only when the server starts — never into a
file that might be committed.

Every server from all three sources is also published to VS Code's own MCP engine
through `vscode.lm.registerMcpServerDefinitionProvider`, so it appears in the
editor's MCP Servers view and Copilot Chat can use it. The editor's language-model
tools flow the other way: the Task Queue's **Context** tab shows everything in
`vscode.lm.tools` — tools other extensions register, and the tools of MCP servers
VS Code runs itself — as a tree grouped by where each came from, so a group can be
checked instead of its members. A checked tool is handed to every agent as
`editor__<name>` and run by the editor on the agent's behalf. A new workspace starts
with the built-in `edit`, `execute`, `read` and `search` sets on and everything else
off, because each tool definition travels with every request an agent makes. The
grouping is `src/editorTools.ts`, the rest `src/mcpBridge.ts`.

The extension also bundles `mfagent-mcp`, a stdio MCP server for Claude Code,
Codex, Kilocode, and other MCP clients. Run **MF Agent: Register Task Queue
MCP Server (Claude Code / Codex)** to wire it up automatically — it runs
`claude mcp add --scope project` and `codex mcp add` in a terminal, so each
CLI registers the server in its own config (Claude Code's project-local
`.mcp.json`, which it will ask you to approve once via `/mcp`; Codex's global
`~/.codex/config.toml`) instead of you hand-editing either file. A CLI that
isn't installed just prints "command not found" in that terminal and can be
ignored. For Kilocode or another JSON-configured client, **MF Agent: Copy Task
Queue MCP Config** copies the equivalent JSON to the clipboard instead.

Its primary tool is
`task_queue_write_plan`, which validates and atomically writes an ordered plan
to `.mfagent/queue.db`. Every task carries self-contained instructions, an
implementation check, a behavior check, and an optional deterministic test
command. The tool supports replace/append modes and a dry run, and returns both
text and MCP `structuredContent`. Beyond that, the server exposes read tools
(`task_queue_list`, `task_queue_stats`) and edit tools for changing the queue
in place without rewriting the whole plan: `task_queue_create` appends a single
task, `task_queue_update` edits any field of an existing task by id (including
its `status`), `task_queue_delete` removes one, and `task_queue_reorder`
renumbers execution order. A compatibility `task_queue_generate` alias is also
exposed. Because Claude Code, Codex, and the extension's own autonomous run all
read and write the same SQLite file, edits made by one are visible to the
others immediately.

---

## Watching the queue run

The queue database is the broker for everything the agents do, and the Task
Queue view reads it two ways: a full redraw whenever the orchestrator says the
state changed shape, and — while the view is showing — a 200 ms poll of the
`agent_logs` table, which every agent writes to as it works: the text and
reasoning it produces, each tool call and what came back, and the activity
records it writes while it waits. Open a task and its **Live output** terminal
shows all of that from every agent that touches it — executor, verifier,
supervisor, and for a phase the planner. Planning from the Plan tab has a
terminal of its own. Rows are pruned per task (`mfagent.queue.liveLogKeep`); the
durable journal the supervisor reads, `task_events`, is separate and never pruned.

The supervisor loop wakes every `mfagent.queue.cronIntervalSeconds` (10 s by
default) and reads the `tasks` and `agent_logs` tables to decide, per task,
whether work continues, stops, is broken down, or goes to verification. In the
protocol the agents speak those are `CONTINUE_EXECUTION`, `STOP_AND_REWRITE_TASK`
and `STOP_AND_REWRITE_VALIDATION`, `SPLIT`, and `START_VALIDATION` — see
`src/queue/monitor.ts` and `src/queue/orchestrator.ts`. A tick that finds nothing
new costs a few indexed reads; a full review of live work is a model turn and is
rate-limited separately (`mfagent.queue.reviewIntervalSeconds`).

## Settings

Providers, models, roles, languages, MCP servers and the browser toggle live on
the **MF Agent Settings** page. What stays in `settings.json` is the handful of plain values the
VS Code settings editor is genuinely good at:

| Setting | Default | Notes |
|---|---|---|
| `mfagent.memory.enabled` | `true` | Graph memory for this workspace |
| `mfagent.mcpServers` | `[]` | See above |
| `mfagent.queue.mode` | `lockstep` | or `continuous` |
| `mfagent.queue.cronIntervalSeconds` | `10` | How often the supervisor loop reads the queue. A task list that picks its own interval in the Task Queue view wins |
| `mfagent.queue.liveLogKeep` | `2000` | Live-output rows kept per task in `agent_logs` |
| `mfagent.queue.maxRounds` | `80` | Maximum tool-calling rounds per unattended turn; retries keep the same ceiling and repeated identical failures stop early |
| `mfagent.queue.maxFilesPerRegion` | `150` | Largest file count one region of the workspace may hold before the deterministic scan splits it further — bounds how much a phase's expansion agent explores in one sitting, regardless of project size |
| `mfagent.queue.workerSilentMinutes` | `10` | How long a worker may write nothing before it counts as dead |
| `mfagent.activityIntervalSeconds` | `30` | How often a working agent records what it is doing |
| `mfagent.llm.idleMinutes` | `30` | How long a reply may deliver nothing before the connection counts as dropped |
| `mfagent.queue.notifyCommand` | `""` | Run with a JSON summary as its one argument when an autonomous run finishes — a script that pings your phone, Slack, or anything else, for the run that finished after you stopped watching |

Changing any of them, or anything on the settings page, restarts the core
automatically.

### No timeouts on agents

A task is never stopped for taking too long, because "too long" is not knowable
in advance: a local model can spend hours on one reply, and that is work, not a
hang. So an agent is not given a deadline — it is asked to keep saying what it
is doing.

Every worker writes a timestamped record to the queue database as it goes: each
round it sends to the model, every thirty seconds it spends waiting on a reply,
every tool call and how long it took. Those records are the run's transcript,
and they outlive the process that wrote them. The supervisor's cron tick reads
the newest timestamp per task, and a task that has written *nothing* for
`workerSilentMinutes` is requeued — not because it is slow, but because nothing
that is alive stays quiet that long.

The one thing that ends a call is a connection that has stopped delivering.
Every byte read from the model resets that window, so a reply that takes six
hours is fine as long as it is still arriving; a socket that delivers nothing
for `llm.idleMinutes` is dropped, and the worker records that it stopped before
it goes.

### Executor-owned validation

The executor owns the expensive verification work. In the same turn that edits
the code it inspects the final diff, runs configured commands and test suites,
and drives the browser for UI work. It finishes with a structured PASS, FAIL, or
INCOMPLETE report containing the observed evidence for every check.

That report is written to `validation_report` in `.mfagent/queue.db` before the
task enters `VERIFYING`. The supervisor receives no tools at all: it reads this
database report, checks that the conclusion is consistent and adequately
supported, and either validates the task or sends it back with revised
instructions. It never reads code, executes a command, or reruns browser tests.

### What is worked out for you

None of this is configurable, because none of it is a preference. The **Detected**
tab on the settings page shows what was found.

| | |
|---|---|
| Languages | Globbed from the workspace; override on the Workspace tab |
| Graph memory DB | `.mfagent/memory.db` |
| Task queue DB | `.mfagent/queue.db` |
| Screenshots | `.mfagent/screenshots/` |
| Agent core binary | Bundled in `bin/`; `MFAGENT_CORE_PATH` overrides |
| Chrome / Chromium | System install, then a Playwright download if one is already cached, then apt, then a cached download; `MFAGENT_CHROME_PATH` overrides |
| Playwright | The project's own `playwright.config.*` and `node_modules/@playwright/test`; nothing is bundled |

Upgrading from an earlier version imports your old `mfagent.providers` setup into the
new store on first launch and offers to delete the obsolete keys.

> **Leave `thinking` on `adaptive`.** With thinking disabled, the model occasionally
> writes a tool call into its visible text instead of emitting a real call — the turn
> succeeds, the call silently never runs, and in an agentic loop that text pollutes
> later turns. If you need to cut cost, lower `effort` instead.

---

## Commands

| Command | Keybinding |
|---|---|
| Focus Chat | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>I</kbd> |
| Edit Selection with Instructions | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd> |
| Ask About Selection | context menu |
| Explain Problems in This File | feeds the file's diagnostics to the agent |
| Show Graph Memory | entities, relations and observations |
| Search Graph Memory | |
| Open Preview in Simple Browser | |
| Show MCP Server Status | |
| Restart Core | |

---

## Development

```bash
npm run watch          # rebuild the extension on change
npm run typecheck
npm run build:core     # host platform only
node scripts/build-core.mjs --all   # cross-compile all six targets
cd core && go test ./...
```

On Windows, `build.ps1` is the one entry point: a plain run is a host build,
`-Package` bumps the patch version, builds every target and packs the `.vsix`,
and `-Install` does that and installs it. `-Bump minor|major|none` controls the
version step; `-Watch` rebuilds the bundle on every save.

Cross-compilation needs no per-platform toolchain — nothing in the core uses cgo.

### Layout

```
src/            extension host shim (TypeScript)
  llm/          the LLM router, and the vscode.lm loopback proxy
  mcpBridge.ts  the MCP bridge: servers ⇄ VS Code, vscode.lm.tools ⇒ core
  queue/        db.ts (the task store), orchestrator.ts + monitor.ts (the
                supervisor loop), panel.ts (the live webview), liveLog.ts
media/          webview UIs (vanilla HTML/CSS/JS)
core/
  cmd/mfcore/   entry point, JSON-RPC method registration
  internal/
    agent/      agent loop and system prompt
    llm/        Anthropic + OpenAI-compatible providers
    memory/     graph store
    tools/      file, search, POSIX, shell, memory, browser tools
    mcp/        MCP client (stdio + streamable HTTP)
    browser/    Chrome DevTools Protocol driver
    rpc/        JSON-RPC transport
```

### Notes on the protocol

Requests are handled **in order** on the read loop. Only `chat/send` is async, since
a turn runs for minutes and must not block cancellation or the permission round-trip.
That ordering guarantee is deliberate: an edit sent before a build must happen before
the build.

---

## Known limitations

- No inline ghost-text completion. This is an agent, not a completion engine.
- `sed` supports substitution only (`s/a/b/[gi]`), not the full script language.
- The browser driver needs Chrome or Edge installed; set `MFAGENT_CHROME_PATH` if
  auto-detection picks the wrong one. There are no Chromium snapshots published for
  linux-arm64, so on those servers a browser has to be installed by hand.
- The `playwright_*` tools run the project's own suite and need Node and
  `@playwright/test` in that project. They are always registered; `playwright_status`
  reports which piece is missing rather than failing opaquely.
- **The Vision role is configured but not yet consumed.** `browser_screenshot` shows
  the image in the chat panel and hands the agent a file path; no image is sent to a
  model. Binding the role is wired end to end — the core reports it and the extension
  passes it through — but nothing calls it yet.
- MCP support covers tools, not prompts or resources.
- Prompt caching is Anthropic-only.
- `better-sqlite3` drives the queue database when a native build for the running
  VS Code's Electron is installed; none is published for Electron 42 as of this
  writing, so the runtime's own `node:sqlite` — the same SQLite, also in WAL
  mode — serves instead. Either way the schema and the file are identical.
- `vscode.lm` has no system role, so on an editor model the system prompt is sent
  as the opening user message; and it reports no token usage, so counts on those
  turns come from the model's tokenizer.

## License

MIT
