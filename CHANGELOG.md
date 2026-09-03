# Changelog

## Unreleased

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
