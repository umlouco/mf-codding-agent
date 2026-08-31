# MF Agent

A lightweight coding agent for VS Code. Clean-room — no Copilot, no dependency on
`vscode.lm`, no notebook support, no ecosystem you don't use.

Built around four things: **graph memory that survives across sessions**, **strong
editing tools**, **POSIX commands that work natively on Windows**, and **real browser
testing**. Plus MCP, so you can plug in anything else.

The whole extension is a **19 KB** JavaScript shim. Everything real happens in a
single compiled Go binary.

---

## Why it's built this way

VS Code only loads JavaScript in its extension host, so a shim is unavoidable. The
shim is kept as small as it can be: spawn the core, pump JSON-RPC, render a webview.
The agent loop, tools, memory, MCP clients and browser driver all live in Go and ship
as one static binary with no runtime dependencies — the same pattern `gopls` and
`rust-analyzer` use.

```
┌─ VS Code extension host ────────────┐
│  extension.ts   commands, gating    │
│  panel.ts       webview chat        │   19 KB of JS
│  core.ts        JSON-RPC over stdio │
└──────────────┬──────────────────────┘
               │ newline-delimited JSON-RPC 2.0
┌──────────────▼──────────────────────┐
│  mfcore  (single static Go binary)  │
│                                     │
│  agent loop ── tools ── graph memory│
│       │         │        (SQLite)   │
│       │         ├─ MCP clients      │
│       │         └─ browser (CDP)    │
│       └─ LLM: Anthropic / OpenAI-compatible
└─────────────────────────────────────┘
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

**`project_info`** — detects languages, tooling, npm/composer scripts, and Delphi
`.dpr`/`.dproj` projects.

**Browser** — `browser_open`, `browser_elements`, `browser_click`, `browser_fill`,
`browser_eval`, `browser_wait`, `browser_screenshot`, `browser_console`. Drives real
Chromium over the DevTools Protocol. `browser_elements` returns interactive elements
with ready-made CSS selectors, so the agent isn't guessing them; `browser_console`
returns errors and uncaught exceptions, so "it compiles" and "it works" stay
different claims. Screenshots appear inline in chat.

**Memory** — `memory_recall`, `memory_trace`, `memory_remember`.

**MCP** — every tool from every connected server, namespaced `mcp__<server>__<tool>`.

---

## Permissions

Anything that writes, executes or navigates goes through one confirmation prompt.
The gate lives in the agent loop, not in the individual tools, so a new tool cannot
ship without it.

Gated: `write_file`, `edit_file`, `multi_edit`, `run_shell`, `browser_open`,
`browser_eval`, every MCP tool, and `unix` pipelines that mutate or redirect.

Not gated: reads, searches, read-only `unix` pipelines, and `browser_click` /
`browser_fill` — you already approved opening that page, and prompting per click
makes browser testing unusable.

"Always allow this tool" is persisted to workspace settings. A declined tool is
reported to the model as a decision, not a failure, so it adapts instead of retrying.

---

## Setup

Requires Go 1.24+ and Node 20+ to build.

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

**Providers.** Pick from Anthropic, OpenAI, OpenRouter, Google Gemini, DeepSeek,
Mistral, Groq, xAI, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, Voyage,
or any OpenAI-compatible endpoint. Each one asks for the fields it actually needs.
You can keep several — a hosted account and a local server side by side.

**API keys** go to the OS keychain via VS Code's `SecretStorage`. Leave a key blank
to fall back to the provider's environment variable (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and so on).

**Models** are fetched from the provider, with context window, pricing and
capabilities where it publishes them. Nothing is hard-coded, so a model released
this morning shows up after **Refresh**.

**Roles** bind a provider and model to a job:

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

The extension also bundles `mfagent-mcp`, a stdio MCP server for Claude Code,
Codex, Kilocode, and other MCP clients. Run **MF Agent: Copy Task Queue MCP
Config** to copy a workspace-aware configuration. Its primary tool is
`task_queue_write_plan`, which validates and atomically writes an ordered plan
to `.mfagent/queue.db`. Every task carries self-contained instructions, an
implementation check, a behavior check, and an optional deterministic test
command. The tool supports replace/append modes and a dry run, and returns both
text and MCP `structuredContent`. Read-only list and statistics tools, a
single-task append tool, and a compatibility generate tool are also exposed.

---

## Settings

Providers, models, roles, languages and the browser toggle live on the **MF Agent
Settings** page. What stays in `settings.json` is the handful of plain values the
VS Code settings editor is genuinely good at:

| Setting | Default | Notes |
|---|---|---|
| `mfagent.memory.enabled` | `true` | Graph memory for this workspace |
| `mfagent.mcpServers` | `[]` | See above |
| `mfagent.queue.mode` | `lockstep` | or `continuous` |
| `mfagent.queue.cronIntervalSeconds` | `60` | Default supervisor wake-up interval. A task list that picks its own in the Task Queue view wins |
| `mfagent.queue.maxRounds` | `80` | Tool-calling rounds per unattended turn — the only budget a task has; retries get 50% more each |
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
| Chrome / Chromium | System install, then apt, then a cached download; `MFAGENT_CHROME_PATH` overrides |

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

Cross-compilation needs no per-platform toolchain — nothing in the core uses cgo.

### Layout

```
src/            extension host shim (TypeScript)
media/          webview chat UI (vanilla HTML/CSS/JS)
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
  auto-detection picks the wrong one.
- **The Vision role is configured but not yet consumed.** `browser_screenshot` shows
  the image in the chat panel and hands the agent a file path; no image is sent to a
  model. Binding the role is wired end to end — the core reports it and the extension
  passes it through — but nothing calls it yet.
- MCP support covers tools, not prompts or resources.
- Prompt caching is Anthropic-only.

## License

MIT
