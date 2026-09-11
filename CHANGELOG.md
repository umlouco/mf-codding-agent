# Changelog

## Unreleased

- Fix a replacement planner that never goes idle running unmonitored for as
  long as it keeps streaming, however long that is. `sweepSilentReview` already
  abandoned one that stalled — no new model output for two minutes straight —
  but a planner that keeps producing tokens continuously never trips that
  check no matter how long it runs, and it is a single response-only turn
  producing one bounded JSON plan, not open-ended work: nothing legitimate
  needs more than a few minutes. While it runs, `tick()`'s own busy-check skips
  every cron tick meanwhile, so the supervisor was not just failing to notice
  this one call rambling — it could not look at anything else in the queue
  until the call finally stopped on its own. `DECOMPOSITION_TOTAL_CEILING_MS`
  (8 minutes) now bounds the total duration of one such turn regardless of
  whether it is still actively streaming; `Review.startedAt` (set once, never
  overwritten, unlike `lastActivityAt`) is what the check reads.
- Fix a rebuilt task's abandoned split lineage never being cleaned up.
  `rebuildFromRoot` restores the task being rebuilt to its full original scope,
  which subsumes the entire collective scope every sibling produced by that
  narrowing strategy was each covering a slice of — but it left every one of
  those siblings sitting in the list at zero attempts, real per the split
  contract but now duplicating work the restored task will redo wholesale, with
  no way to ever get a "real" answer of its own beyond waiting for a lockstep
  queue to reach it. `pruneAbandonedLineage` now deletes every task whose own
  `region.scopeSplit.archiveKey` names a split anywhere between the task being
  restored and the root, at every generation, skipping anything already
  `VERIFIED` — the same set `decompositionAncestry` already walks to find the
  root, just used to find what that lineage produced rather than only where it
  came from.
- Fix `stopForDecision` letting a stale decision overwrite a fresher one that
  had already committed. Its `EXECUTING` branch was already guarded — `finishExecution`
  writes only if the row is still on the same `attempts` the caller last saw — but
  every other status fell through to a plain, unconditional `queue.update`, with
  no check that the row was still what the caller's snapshot said it was. A decision
  is computed from a snapshot fetched earlier, sometimes across a genuinely slow
  gap (hashing the workspace, a model round-trip), so a second, independently-triggered
  decision that read the same earlier snapshot could still land after a first one
  already committed something else — silently clobbering it with a conclusion drawn
  from information that was no longer true. Confirmed live within the SAC queue
  the same night `verificationStallStreak` (above) first fired: a task rebuilt back
  to its full original scope was punched straight back into "needs decomposition"
  52ms later, using a verification-cap reason string computed *before* the rebuild —
  the rebuild had already happened, but nothing had told that other, slower decision
  its premise no longer held. `updateIfUnchanged` (`dbWrites.ts`) gives every status
  the same `updated_at`-fenced compare-and-swap `finishExecution` already used for
  `EXECUTING`; `stopForDecision` now goes through it uniformly.
- Fix independent verification's own inability to converge reading as a scope
  problem and being split forever instead of ever being fixed. `admitDecompositionFamily`'s
  32-split family budget counts every split alike, so a task whose only real
  obstacle was that verification itself never reached a verdict — `verifyWithExecutor`'s
  interaction budget or two-pass cap, `supervise`'s two-decisions cap — kept being
  replaced with narrower "verify/reconcile/inventory a prior verification attempt"
  children: the identical wall, one layer down, every time. Confirmed live on a SAC
  workspace queue: one analysis task ran through 30+ such generations over several
  days with no implementation defect ever found and no verified proof ever produced,
  while every other task behind it sat at zero attempts the whole time (the queue
  runs lockstep). `verificationStallStreak` (`dbFailureLineage.ts`) now counts
  consecutive splits in a family forced only by these three host-generated reasons;
  from the second one, the decomposition prompt is told explicitly to stop narrowing
  what is being checked and point back at the original deliverable with one concrete,
  mechanical check instead, and a third in a row skips the split entirely and rebuilds
  the task from its root instead — the same escalation `rebuildFromRoot` already uses
  when other bounded allowances run out.
- Fix `task_events` — documented as an "append-only audit trail" — actually
  cascade-deleting a task's entire history the moment that task was replaced
  or removed. Every prior iteration's evidence (tool calls, model turns,
  decomposition activity) vanished with it; the only trace left was a
  best-effort JSON snapshot a split happens to take of the row on its way
  out, undiscoverable without knowing to go look for it and unqueryable
  without manually parsing it. `task_events.task_id` is no longer a foreign
  key: a database written under the old schema is rebuilt once, losslessly,
  on next open. A task's full lineage — including a task since split or
  deleted — now stays directly queryable by its original id, which is what
  actually made this incident's `providerUnavailable`/`rebuildFromRoot` fixes
  possible to verify tonight instead of having to reconstruct them from those
  snapshots. The two archive snapshots (`split-archive`, and the
  `scopeSplit:*` metadata `applyVerdictSplit` writes) drop their own embedded
  copy of the same events for the same reason: duplicating a permanent
  journal into a one-off blob no longer buys anything.
- Fix decomposition being requested over a transport or provider outage instead
  of an actual task problem. A verifier or supervisor call that never reached
  the model — a DNS failure, a dead connection, a Claude CLI spend-limit
  refusal — used to be logged and counted exactly like the model reviewing the
  task and failing to verify it: two such outages back to back (`supervise`'s
  two-decisions cap) or a verification budget burned entirely on failed
  connection attempts (`verifyWithExecutor`) were enough to retire the task and
  start replacing it with narrower ones, and a replanning call that itself hit
  the same outage spent part of the bounded per-input replan allowance for
  nothing. Confirmed live in two separate workspaces during the same overnight
  internal-LLM outage: one task was silently re-split about 30 times over
  several days into meaningless "hold this value, pass it through unedited"
  fragments before the family's 32-split budget ran out. `providerUnavailable`
  (`recovery.ts`) now recognizes this class of failure and every one of these
  call sites backs off and retries automatically instead of treating it as
  evidence about the task; `DECOMPOSITION_STRATEGY` moves to v8 so a task
  already parked under the old blind fingerprint gets one bounded fresh look.
- Fix a family that has run out of its bounded replan allowance stopping the
  run instead of continuing on its own. Repeated narrowing that never reaches
  a verified outcome used to park the task waiting on a person to change the
  planner, the workspace, or the owner's requirements — and because the queue
  runs lockstep, every task behind it sat at zero progress until someone
  did. This queue never stops for a human elsewhere (no task is terminally
  failed; see the "bounded supervisor decomposition" entry below), so it
  should not start here either: `rebuildFromRoot` now undoes the narrowing
  instead, restoring the task to the original, complete job an ancestor
  archive still has on record and trying that directly, on a fresh lineage, in
  place of another split. Two such rebuild-and-resplit cycles failing the same
  way hands the task to ordinary autonomous recovery (bounded backoff, retried
  indefinitely) rather than rebuilding a third time — still no human step, no
  terminal failure, just a different autonomous move once narrowing has
  demonstrably stopped helping.
- Fix autonomous recovery retrying an unwinnable diagnosis forever: `rememberRecoveryStrategy` correctly recognized the supervisor proposing the identical operation again with no new evidence, but the surrounding loop treated that rejection as just another reason to back off and ask again on a 5-minute timer — capped only by transport-level backoff, never by whether repeating the question could possibly produce a different answer. Confirmed live: 158 consecutive identical `VERIFY` cycles over ~16 hours on one task. A new `strategyStreak` now counts consecutive identical proposals; three in a row escalates to failure-decomposition (replace the task) instead of deferring indefinitely.
- Failure-decomposition replacements must now state `targets`: the files each one will edit. The host rejects any replacement listing more than 3, forcing an oversized "fix every occurrence across the codebase" task to be partitioned by file/directory population at plan time — instead of only being discovered as too large after it has already failed for hours across several splits.
- Fix the failure-decomposition retry budget being silently renewed forever: its admission fingerprint included the same fine-grained per-file workspace revision that the post-plan staleness check compares against, so a file touched anywhere in an active workspace during a long planning call both discarded the finished plan and looked like a brand-new input, defeating the 3-attempt cap and replanning the same stuck task over and over. The retry fingerprint now uses a coarser, file-existence-only revision (`decompositionRetryRevision`); the staleness check keeps its original byte/mtime sensitivity.
- Fix Claude CLI planning on root/sudo extension hosts: use non-interactive `dontAsk` with explicit built-in and bundled MCP tool approvals, preserving Claude deny rules and testing hooks. Response-only turns no longer request bypass mode. Non-root tool-enabled turns retain their existing permission mode.
- Retain OpenAI-compatible streamed reasoning in the provider's observed field during the current tool-call sequence, while removing it after a new user turn and keeping it out of visible answer content. Project runtime observations into existing request/result messages instead of introducing conversational turns that strict local templates reject.
- Merge adjacent OpenAI-compatible user context messages without crossing tool-call/result boundaries. A real Devstral Small 2 trial exposed a strict chat-template failure after the first tool invocation.
- Queue workers allow 80 rounds by default, preserving explicit user limits and existing failure/context guards. Streaming tool arguments now update useful-progress telemetry without logging their content.
- Deliver optional live supervisor guidance between native worker tool rounds, preserving it for handoff without restarting the task. Refresh progress evidence after requirements reviews, and repair incomplete requirements decisions once without inventing missing checks.
- Keep cognition observations before the current request and describe historical failures as historical. Distinguish actual test errors from identical report footers, preserve PowerShell here-string contents, and reject empty or entirely skipped Playwright runs as verification.
- Compare derived task contracts against owner requirements in an isolated response-only review. Incomplete rewrite decisions cannot authorize verification, and cancelled reviews cannot overwrite replacement activity with a late error.
- Recover repeated successful observations that make no progress, with a warning before handoff. Verify that browser fills retain the requested value and explain unsupported native selector syntax.
- Allow configless Playwright suites. Bound large search previews, preserve exact count mode, and avoid classifying UTF-8 source as binary when the sampling boundary splits a character.
- Add fixed workspace testing URL and named credential fields to the task queue. Store credential values in VS Code SecretStorage, support terminal-only credentials, expose references to native browser and child-process tools, and require explicit target comparison in progress reviews.
- Reject ordinary substitute-server commands and conflicting browser/loopback targets through native execution and the Claude CLI pre-tool hook; publish the same testing tools over bundled MCP.
- Add `apache_rewrite_check`: actual HTTP rewrite probes, bounded front-controller repairs, preserved access rules, backups, rollback on failed application checks, and recovery from interrupted tool processes.

- Preserve verification corrections alongside task rewrites, including explicit removal of an invalid saved command while retaining the required check. Restore supervisor tool definitions for inspection and apply its configured round ceiling. Strengthen owner-requirement precedence over inherited task text and fixture-based recovery. Retain host command evidence even after a long verifier inspection.
- Live replay follow-up: execute saved verification commands directly through the portable shell, compare command claims with actual tool inputs, and attach observed outcomes to supervisor evidence. Reverification can repair command quoting without changing implementation or behavioral requirements. Separate bounded agent findings from owner notes. Keep completed tool evidence visible despite streamed prose and duplicate start announcements.
- Restore repeated-error handoff with cognition enabled. Honor VS Code's completion signal by requesting a final report instead of reentering the tool loop. Ready handoffs start independent verification without a redundant preliminary review, and completed stages wake supervision without waiting for the cron. Transport keepalives are no longer displayed as generated model output.
- Fix portable `grep -c`, basic versus extended expression semantics, fixed-string matching, unsupported grep options, and `tail -n +N`. Preserve real PowerShell output beside progress/error XML. Preserve Claude CLI streamed tool arguments and failed result status. Package only runtime binaries, excluding unrelated executables left in `bin`.

- Recover queue progress after the Plugins/ECM overnight stalls: fence superseded worker callbacks and abort handles, preserve executor handoffs, and keep heartbeat traffic from displacing review evidence. Productive interrupted turns can continue without rewriting requirements. A new REVERIFY decision repeats missing verification without rerunning implementation. Project notes now reach verifiers, supervisors, recovery turns, and phase expansion. Accept complete top-level validation reports and evidence in typed checks; reject claimed command/browser success without corresponding observed tool execution. See `docs/queue-incident-2026-09-06.md` for findings and validation limits.

- Fix **Edit Tasks** silently applying only the first 40 requested edits, deletions, or additions. Complete revisions now commit in one database transaction, use the task identities shown to the planner, and report the actual saved counts. Invalid, interrupted, or conflicting proposals leave the queue unchanged.

- Add Visual Witness layout checks: text-only executors can call `browser_layout_check` or `playwright_layout_check` to obtain criterion-based findings from the Vision role, backed by a saved screenshot and DOM measurements. Unstable captures, missing anchors, malformed model replies, and unavailable vision return incomplete evidence. Image transport now works through OpenAI-compatible, Anthropic, and VS Code model adapters; queue workers retain Vision provider bindings and account for its tokens.
- Run browser interactions in order and isolate browser profiles per worker. Logins no longer persist between queue workers; authenticate per task or supply existing Playwright storage state. Playwright uses the installed Node CLI without shell interpolation or implicit package downloads, and cancels descendant processes on Windows/Linux. Explicit workspace extension placement keeps browser execution on the SSH host. See `docs/visual-witness.md`.

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
