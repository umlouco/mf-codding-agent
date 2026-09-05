# Changelog

## Unreleased

- Target VS Code 1.136 and newer only. Every version guard and fallback for an older editor is gone: the MCP definition-provider registration no longer checks whether the API exists, the per-user `mcp.json` write that stood in for it is removed, and the shell-integration capability probe is replaced by the `mfagent.shell.useTerminal` setting alone.
- New provider **VS Code Language Models**: the models the editor offers through `vscode.lm` — Copilot's, and any other vendor an installed extension registers — with no key of your own. A loopback proxy in the extension host (`src/llm/lmProxy.ts`) presents them to the Go core as an OpenAI-compatible endpoint, so every tool and the queue's per-role process isolation work unchanged; `src/llm/router.ts` decides per role which transport carries a turn — the core's own HTTP clients, that proxy, or the Claude CLI.
- MCP servers get their own tab on the settings page, with API keys kept in the OS keychain and injected only when a server starts. Every server this extension knows about is published to VS Code's own MCP engine through `registerMcpServerDefinitionProvider`, and the editor's `vscode.lm.tools` are offered back to the core as `editor__<name>` tools, chosen per workspace on the Task Queue's Context tab (`src/mcpBridge.ts`).
- The Task Queue's **Context** tab is a tree instead of three flat checklists. The editor's language-model tools are grouped by where they come from — `Built-In`, holding one row per capability set (`edit`, `execute`, `read`, `search`, `browser`, `web`, `vscode`, `todo`, `agent`), then a row per extension namespace and per MCP server the editor runs — and a group's tri-state checkbox switches everything under it in a single write. MCP servers and skill groups unfold the same way, one filter box runs over all three trees, and a badge counts what is on. A workspace that has never picked now starts with the built-in `edit`, `execute`, `read` and `search` sets switched on rather than nothing: a hundred-odd checkboxes standing between a fresh workspace and an agent that can read a file is not a choice anyone was making. The first toggle writes the whole list, defaults included, so switching the last tool off still means off, and **Restore defaults** puts the starting pick back (`src/editorTools.ts`).
- Live output. Every agent streams its text, reasoning, tool calls and activity into a new `agent_logs` table as it works; the Task Queue view polls it every 200 ms and shows a terminal per task, and one for the planner, so the interface keeps moving for as long as an agent is. Rows are pruned per task (`mfagent.queue.liveLogKeep`); the supervisor's journal in `task_events` is untouched.
- The supervisor loop's default interval drops from 60 s to 10 s (`mfagent.queue.cronIntervalSeconds`, minimum 5 s). The model-driven review of live work keeps its own, slower rate.
- The `claude` CLI provider takes its prompt on stdin instead of argv, so a planner prompt carrying a whole queue no longer trips the Windows command-line limit, and a CLI that fails to start is reported as that turn's error instead of an unhandled event.
- A verifying task shows its live activity in the task list, and a validator turn that stayed silent still refreshes the view with its cost and verdict.
- Fix an infinite loop that froze the extension host. `parseCompletionClaim` walked an executor reply's opening braces from the end with `lastIndexOf('{', start - 1)`, which at index 0 finds index 0 again, so a reply beginning with `{` that did not parse, or lacked the `completion` key, never returned. The supervisor's progress review calls it before its first `await`, so the whole host spun at 100% — from activation, once a start resumed a run with a task awaiting verification. The walk now stops at 0, and the review a start triggers runs a second after `activate()` has returned rather than inside it.
- Start no longer refuses a queue whose only open tasks are awaiting verification. The button counted PENDING tasks alone, so a run whose last task had reached VERIFYING answered "Nothing to run" and could never finish; it now starts the supervisor for those tasks, reviews them at once instead of after a full interval, and a supervisor turn in progress, or one that fails, shows on the task's row.
- The Task Queue's Context tab shows, beside each MCP server, what the last core start made of it — connected, or the server's own refusal — and a **Set key…** action gives any server an API key of its own without editing the file it came from: a copy under the same name on the settings page, which wins at discovery, with the key in the OS keychain. A rejected key's warning now says whether the `Authorization` header carried a bare token with no scheme, and carries the server's `WWW-Authenticate` challenge.
- The `mcp.json` reader also honours a bare `${NAME}` environment reference, Claude Code's spelling, when such a variable exists, so a server block copied from `~/.claude.json` keeps working.
- The `mcp.json` reader expands `${env:NAME}`, `${workspaceFolder}` and `${userHome}` as VS Code does; a server whose value needs `${input:…}` or `${command:…}`, which only the editor can resolve, is left out with a note on the Context tab instead of being sent with placeholder text. MCP connection warnings now name the file or page a definition came from.
- Stop an executor after the same tool failure occurs in three of the last eight tool rounds, including mixed-success batches and intervening successful calls. Browser evaluation error positions are ignored when matching failures, so changing broken quoting still produces a supervisor handoff.
- Preserve recovery feedback and recent failure history when an attempt budget restarts. Live supervisor task and validation rewrites also restart exhausted budgets, while unchanged rewrites cannot reset them. Browser evaluation tool instructions explain explicit returns, DOM serialization, and using supplied verification scripts intact.
- Clarify hard-coded prompts for less capable coding models: concrete implementation steps, valid JSON examples, evidence-based recovery that preserves acceptance criteria, and independent verification without editing source or tests. Preserve structured output during core handoffs. See `docs/prompt-review.md` for findings and the live evaluation procedure; model quality improvements have not yet been benchmarked.
- Split implementation from verification. The agent that does the work no longer grades it: it reports what it changed and whether it believes the task is ready, and the supervisor starts a separate verification agent — its own process, its own context, told to distrust those claims and check the workspace itself — whose findings are what the accept/reject decision is made on.
- Show detailed live activity plus cache reads separately in task rows.
- No task is ever terminally failed, and nothing is accepted or rejected because a number got large: whether work passes is decided by the recorded evidence alone.
- A task's `maxAttempts` is a real limit again, on how long one *formulation* of a task may be retried rather than on the task itself. Reaching it never fails anything; it narrows the supervisor's choice to the two decisions that actually change something — split the task when scope is the obstacle, or rebuild its description from the goal the plan was generated from when it is unclear, self-contradictory, or impossible as written — and the replacement then starts again with a full budget. Between the ceiling and the reset, a row can no longer read "attempt 7 of 3", and a supervisor can no longer send a fourth phrasing of an instruction that has already failed three times.
- Accept simple `&&` chains in Windows `run_shell` calls and decode PowerShell CLIXML errors into actionable text.
- Bound a turn that runs with no round ceiling by the size of the conversation it has built, not by a round count: past `mfagent.llm.maxContextTokens` the core stops the tool loop and asks for a handoff report, so an agent that keeps calling tools without converging reaches its supervisor with an account of what it did instead of dying inside the provider's context limit.
- Journal the worker's own reasoning and replies, not just its tool calls. The supervisor has no tools and judges live work from that journal alone, so what an agent never writes there is something nobody can review.
- Look in on a running task on `mfagent.queue.reviewIntervalSeconds` rather than on every cron tick, and skip the look entirely when the journal has not grown since the last one. A task that has stopped is never gated — it is waiting on the decision, not being polled.
- Record a verification run that could not complete, in the journal and in the task's error log, and show the supervisor how many times it has already happened. It is still a decision rather than a limit, but a supervisor that cannot see it will keep sending the same verification agent at the same wall.
- Read the implementation agent's closing completion claim as structured data and put it in front of the supervisor as a claim, rather than leaving it as prose in a report nothing parsed.
- Send a worker that died without reporting straight to the supervisor instead of counting how many times it has died first. Requiring a second identical crash before anyone looks is an attempt limit under another name; `mfagent.queue.noReportEscalateAfter` and the streak it counted are both gone.

Tool-surface changes aimed at one failure mode: the agent routing work through
shell scripts and Python heredocs instead of the tools built for it, then
explaining the detour with invented facts about the tools.

- **The permission gate is gone.** `Tool.Confirm`, `Env.Ask`, the
  `permission/request` round-trip and the `autoApprove` setting are all removed;
  nothing asks before it runs. In practice nothing did: both the chat and the
  queue were already sending `autoApprove: ['*']`, and the chat never registered
  a `permission/request` handler at all — so a narrowed `autoApprove` would have
  failed tool calls with `method not found` rather than prompting. The code now
  matches what the product does.
- In its place, every tool call reports a one-line summary as it starts, from the
  tool's own `Summarize`, shown in the chat next to the tool name. Notice rather
  than consent, but it is written by the tool and knows what the webview cannot
  infer — which `unix` scripts write, how many lines a `write_file` is.
- `unix` scripts are still classified as reading or writing from the parsed
  script, now to decide execution order (writes are sequenced against the edits
  around them, reads run in parallel) and to produce that summary.
- Refusals from `read_file`, `write_file`, `edit_file` and `multi_edit` now name
  the call that gets past them, and say outright that the shells reach the same
  files through the same root, so writing around a refusal is not a fix.
- `grep` gains `output_mode` (`content` / `files` / `count`), `capture` for pulling
  one regex group out of every match on a line, and `unique` for deduplicating and
  counting distinct values. Counting ignores the result limit so the total is
  exact. `files_only` still works as an alias for `output_mode: "files"`.
- `run_shell` runs in a real VS Code terminal when shell integration is available,
  inheriting the user's own shell, profile and `PATH`, and staying on screen to be
  watched and scrolled back through. Falls back to spawning a shell otherwise, and
  reports `exit=unknown` rather than assuming success when no exit status is
  available. New setting: `mfagent.shell.useTerminal`. Requires VS Code 1.93.
- The system prompt no longer suggests a Python script for questions that `grep`
  answers, and asks for a disagreeing count to be reported rather than re-derived.
- `mfagent-mcp` gains `task_queue_update`, `task_queue_delete`, and
  `task_queue_reorder`, so Claude Code, Codex, and other MCP clients can edit an
  existing plan in place — retitle a task, change its status, drop one, or
  resequence — instead of rewriting the whole queue through
  `task_queue_write_plan`.
- New command **MF Agent: Register Task Queue MCP Server (Claude Code /
  Codex)** actually registers `mfagent-mcp` with both CLIs — running
  `claude mcp add --scope project` and `codex mcp add` in a terminal — instead
  of leaving it to a clipboard paste the user had to act on themselves. This
  is the fix for the server existing but never actually showing up in either
  tool. **MF Agent: Copy Task Queue MCP Config** remains for Kilocode and other
  JSON-configured clients.
- New **Project notes** field on the Task Queue's Plan tab — free text
  prepended to every execution agent's prompt. This is the one deliberate hole
  in task isolation: every task otherwise runs in a fresh process with no
  memory of any other, so a fact task 1 establishes (stack, test framework,
  where something lives, how to build) would never reach task 3 except by
  task 3 rediscovering it on disk. Seed it with standing conventions, and it
  also grows on its own: the executor's JSON report gains an optional `notes`
  field, and anything a task puts there is appended for every later task to
  see. Stored in `queue_meta`, so it survives regenerating the plan.

## 0.1.0

Initial release.

- Graph memory (Observations / Retrieval / Substrate tiers), scoped per workspace
- File, search, POSIX shell, real shell, browser and MCP tools
- Anthropic and OpenAI-compatible providers (OpenAI, OpenRouter, DeepSeek, Mistral,
  Groq, xAI, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, Voyage, or any
  OpenAI-compatible endpoint), with per-role provider/model binding and reasoning-effort
  control
- Autonomous task queue backed by SQLite, with a supervisor loop that retries, splits
  or rolls back tasks until every one verifies — no attempt limit, no terminal failure
- Executor-owned validation: executors run code, commands, tests, and browser checks,
  persist structured evidence in SQLite, and tool-less supervisors only judge that evidence
- Bundled task-queue MCP now exposes an atomic, schema-rich plan writer with dry-run,
  append/replace modes, verification criteria, annotations, and structured results
- Project instructions from `AGENTS.md`, `CLAUDE.md`, or `.mfagent/instructions.md`
- Optional notify command on autonomous-run completion
