# Changelog

## Unreleased

- Stop an executor after three identical tool failures instead of allowing a malformed call to consume the full round budget.
- Split implementation from verification. The agent that does the work no longer grades it: it reports what it changed and whether it believes the task is ready, and the supervisor starts a separate verification agent — its own process, its own context, told to distrust those claims and check the workspace itself — whose findings are what the accept/reject decision is made on.
- Show detailed live activity plus cache reads separately in task rows.
- Remove attempt counts from every decision. Nothing escalates, retries, or gives up because a number got large; tasks are rewritten or split on the quality of the recorded work, and are never terminally failed.
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
