# Plugins queue incident, 6 September 2026

Inspected `root@192.168.10.210` through read-only SQLite connections and process/log
inspection. No server queues, application files, settings, or processes were changed.
Credentials from saved requests and project notes are deliberately omitted here.

## What happened

At 09:36–09:57 UTC, `/var/www/html/public/plugins` had 27 verified tasks, task 28a
(database ID 53) in execution/verification, and 21 pending tasks. Its last recorded
VERIFIED verdict was 5 September at 11:47 UTC. Task 53 had 54 execution claims
since its creation at 19:18 UTC, including 48 after midnight in the 09:37 snapshot.
Neither inspected queue recorded a VERIFIED verdict after midnight.

The original Plugins request explicitly required browser/Playwright testing of the
deployed application at `https://phpeight.pixelentropy.eu/plugins/`, including layout
and behavior. The task history shows this progression:

1. By 19:24–19:31 on 5 September, the supervisor repeatedly shortened the task
   after context-limit failures, directing workers to a localhost test fixture.
2. At 23:43 it diagnosed a Python server launched with `&` holding a shell open
   for over four hours. The current workspace already contains the bounded pipe
   drain fix documented in the previous day's observation report.
3. Overnight, repeated rewrites replaced browser verification with static analysis,
   then restricted execution to exactly one file-read tool call. The supervisor
   began rejecting browser calls as violations of its own rewritten instructions.
4. By 08:53–09:30, the task was checking the format of a markdown table and final
   line in `task28_output.txt`. This no longer established the requested application
   behavior. The verifier also claimed a check script passed although the recorded
   tool evidence for that turn showed a file read, not script execution.

ECM separately confirmed the Project notes defect: its notes contained the test URL
and credentials, but the independent verifier and supervisor prompt builders did
not receive them. The verifier's task journal contained no tool records mentioning
the supplied host and ten mentioning localhost. The executor had records mentioning
both, so the evidence does not support saying every role always ignored the URL.

Both extension hosts were loading `mf-agent-0.1.20`. Version 0.1.21 was installed
at 00:04 UTC but was not loaded by those sessions. The binaries and JavaScript
bundles differ. Several identified defects were also present in this workspace's
0.1.21 source, so simply reloading that version would not fix the entire incident.

## Causes addressed in 0.1.22

- **Worker ownership race.** A superseded executor's `finally` unconditionally
  cleared the current executor's abort handle. Late callbacks were journaled even
  after the task moved to another attempt. Resettable attempt numbers were not a
  unique identity. Generation and committed-claim checks now fence callbacks,
  abort registration, cleanup, and results, including phase expansion. A claim
  now returns its committed timestamps and cleared validation report.
- **Cancelled startup could restart.** Aborting while asynchronous provider setup
  was pending could be followed by `initialize`, whose RPC path starts a stopped
  core. Cancellation is now checked before initialization and before chat starts.
- **Liveness displaced evidence.** Forty recent journal rows could be entirely
  heartbeat messages. Review queries now exclude activity records and prior-attempt
  executor evidence. Heartbeats and the supervisor's own decisions do not trigger
  another paid review. The live activity display still receives heartbeats.
- **Missing shared instructions.** Notes now reach execution, phase expansion,
  verification, progress review, verdict review, and supervisor recovery/formatting
  turns. Owner-supplied environments must be preserved; appended agent findings
  are distinguished from owner authority.
- **Recovery chose the wrong stage.** Continuing a stopped worker used to start
  verification. It now resumes the handoff without rewriting requirements. REVERIFY
  repeats verification with explicit follow-up while preserving implementation,
  task descriptions, and acceptance checks. Unreadable supervisor replies preserve
  the task instead of manufacturing a reason to rewrite it.
- **Handoffs were overwritten.** Verification no longer replaces the executor's
  output field. Independent reports remain in `validationReport` and their journal.
- **Report handling caused cosmetic retries and accepted unsupported claims.**
  Complete top-level reports are accepted without JSON repair. Typed checks can
  supply evidence omitted from duplicate summary fields. Failed, missing, truncated,
  or contradictory evidence remains unverified. Claimed command/browser success
  additionally requires a successful tool execution of the corresponding category
  in the independent verifier's turn.

## Validation and limits

The initial 97 JavaScript regression tests and TypeScript typechecking passed.
The suite has since been expanded during the live replay described below. The
0.1.22 package builds the extension and both Go binaries for Windows, macOS,
and Linux, on x64 and ARM64.

The regression suite exercises real SQLite and orchestrator control flow with
scripted model responses. It reproduces replacement-worker races with reused
attempt numbers, delayed startup cancellation, a thousand-heartbeat journal, note
delivery, unsupported success claims, continuation, and a three-task queue that
finishes after a verification-only retry without rerunning implementation.

These checks establish repaired control flow, not proof of completed application
work. Independent review still needs to compare actual evidence with the original
request and owner instructions.
Prompt changes cannot guarantee model compliance. Existing supervisor-rewritten
task text on the server has not been restored or marked successful by this change.
The new package must be installed and the remote extension hosts reloaded before
these fixes can affect those sessions.

## Isolated live replay

At the owner's request, the complete Plugins application, a consistent SQLite
queue/memory/cognition snapshot, and a transactional MariaDB dump were copied from
the server. The original snapshot archive is retained. All replay setup and
application files live outside the extension repository in a separate sibling
directory. No project-specific paths, fields, credentials, or expected results
were added to product code.

The local application uses the laptop's XAMPP Apache/PHP and a dedicated MariaDB
data directory, listening only on loopback ports 18780 and 13308. Existing server
services and original queues were left untouched. Site URLs and workspace paths
were translated only in the copy; the supplied account authenticates successfully
in an actual Playwright browser. A separate VS Code profile loads the development
extension with the original Qwen executor and DeepSeek supervisor configuration.
The observer starts/stops the queue through extension commands and records status
snapshots and logs. It does not supply model answers or mark tasks successful.

The replay reproduced additional failures:

- A verifier created an output file and claimed the required script had passed.
  The supervisor accepted it. That local false pass was explicitly invalidated
  and journalled, with a database backup retained before the correction. It does
  not count as successful progress. Verification now compares exact command inputs,
  records actual tool outcomes, and executes a saved verification command directly
  through the same portable shell before the model reviews its results.
- Windows portable `grep -c` silently ignored the count flag and returned matching
  lines. It now returns per-input line counts and the proper no-match status;
  unsupported options fail explicitly. Pipeline, fixed-string and exit-status
  regressions exercise the real portable shell. The replay also exposed incorrect
  basic-expression semantics for literal pipes and incorrect `tail -n +N` behavior;
  both are fixed and tested without application-specific fixtures.
- PowerShell progress XML was mixed into command output. Normalization now retains
  stdout beside serialized errors/progress instead of losing output or returning
  progress serialization as evidence.
- Runtime cognition disabled the repeated-tool-error handoff. A live verifier
  repeated the same quoting error until its 24-round ceiling. The repeated-error
  handoff now remains active with cognition attached; recovery before that
  threshold remains possible and tested.
- Generated findings accumulated in the owner-notes field. New findings now have
  separate storage, provenance, a bounded context, and a separate UI display.
  Legacy mixed notes are preserved because their authorship is not reliably known.
- The Claude CLI adapter dropped streamed tool arguments and labelled error
  results as completed. Its evidence stream now preserves both arguments and
  failure status; the verification gate recognizes the CLI's command tools.
- Repeated successful source reads disappeared behind streamed prose, duplicate
  tool-start entries and cognition snapshots. A supervisor then falsely claimed
  that the source was never read. Reviews now favor completed tool evidence and
  one current cognition snapshot; the live stream remains available separately.
- The worker repeatedly called VS Code's completion tool and then reread files.
  A successful completion signal now requests the final handoff report and ends
  tool use. This is a completion claim, not automatic verification. Normal ready
  handoffs skip the redundant preliminary review and still require independent
  verification followed by a supervisor verdict. Completed stages wake the queue
  without waiting for its periodic liveness scan.
- Transport keepalives were displayed as an actively arriving model response.
  Activity now distinguishes connection traffic from decoded model output. The
  existing connection-idle policy is unchanged.

At approximately 11:27 UTC the supervisor repaired the saved command through the
new command-only REVERIFY path. The host runner and independent verifier both
executed it successfully, rather than asserting success after a file read. This
establishes the output-format check; application behavior remains a separate task.

The live replay is still under observation. A queue advancing after a false pass
is not evidence of success, and the remaining application tasks have not yet been
established as complete. Local reloads while developing fixes are recorded in the
observer log and must be distinguished from autonomous uninterrupted execution.


## Fixed testing fields and Apache tool follow-up

At 12:34 UTC, the copied queue saved its translated application URL and original
supplied account through the extension's configuration command and VS Code
SecretStorage. No credential values were logged by that configuration operation.
At events 34264 and 34299, the native tool rejected navigation that skipped the
configured entry URL. The worker then opened that entry URL (34306), opened the
login page (34328), and successfully invoked named username/password fills
(34335, 34342). It subsequently returned to the old fixture, which remains a scope
failure; successful credential use is not evidence that the actual application was
tested or that this task completed. The supervisor had incorrectly endorsed the
fixture because it shared the supplied host (34323). Progress decisions now require
an explicit comparison between owner requirements and observed work, and reject a
continue/validate action that simultaneously reports a scope mismatch. This still
requires model judgment about application semantics; it is not an automatic proof.

The observer independently exercised seven conditional controls in the authenticated
application, waiting for its real initialization before checking hide/show, disabled
state, and cleared values. Those checks passed with no browser errors. They remain
separate observer evidence and did not mark a queue task successful.

The actual Apache MCP tool was exercised against the copied installation and a
separate deliberately broken Apache regression application outside this repository.
The copied app's rewrite engine passed, but the requested pretty route returned 404:
both attempted repairs rolled back, preserving the original `.htaccess`. The separate
regression route changed from 404 to 200 only after the tool repaired the routing
prefix and verified the expected application response. Killing an in-flight native
MCP check and invoking it again restored the original file and removed stale probes.
Artifacts: `artifacts/apache-tool-check.json`, `artifacts/conditional-browser-check.json`,
`artifacts/harness.log`, and `artifacts/status.jsonl` under the replay directory.

The observer rebuilt Windows dependency shims with `npm rebuild --ignore-scripts`
after the Linux copy. Earlier the worker installed Playwright globally and downloaded
browser binaries; subsequent global npm installs were scoped to the replay runtime.
These setup interventions and development reloads are recorded in the observer log.
They are not attributed to autonomous queue recovery. The original remote queues and
application remain untouched. At this observation boundary, only 28 of 49 copied
tasks were VERIFIED; the remaining work must not be described as completed.

## Continued observation after the user's task-29 report

The supervisor could request `STOP_AND_REWRITE_TASK` without supplying a rewrite.
The orchestrator then started verification of the very approach the supervisor had
rejected. Incomplete rewrites now fail visibly while preserving execution state;
they never authorize verification. Format repair also inherited the coding system
prompt and cognition context, producing more investigation or XML instead of a
decision. Response-only reviews now have a dedicated system prompt, no coding
tools, and no projected execution context (telemetry remains recorded).

A separate requirements comparison sees the original goal, owner instructions,
and derived task contract before the supervisor reads accumulated recovery advice.
At 13:14 UTC it rejected the demonstration-page contract (event 34860), supplied a
corrected real-application task (34861), and restarted execution (34862). The worker
then called `testing_environment` and opened the supplied entry URL. This establishes
recovery of task direction, not completion of task 29.

Observed tool friction included Playwright status incorrectly requiring a config
file, native CSS tools receiving Playwright-only selectors, and PowerShell's curl
alias rejecting curl CLI flags. The runner now permits default configuration,
tested with the installed Playwright CLI and a real configless assertion. Native
browser query errors explain the supported selector syntax, and the shell tool
documents `curl.exe` on Windows. No application names, selectors, or credentials
are embedded in these fixes.

The corrected worker subsequently entered named credentials, clicked submit, and
then reopened the same login page repeatedly without a new submission. Its final
handoff claimed authentication was broken. Independent Playwright and direct native
`tools/invoke` checks both authenticated the supplied account; native field-value
comparisons also matched. This does not establish why that worker's click failed to
submit. The extension now checks that fills actually retain the requested value.
Repeated identical observations warn at three consecutive calls and hand off for
recovery at five; actions and explicit waiting tools are excluded. The owner updated
the testing environment through the UI during observation; later workers receive
that configuration. No observer rewrote this task or supplied a passing verdict.

The worker's broad source search returned 237,562 characters in 201 lines, with one
53,340-character line. Its final request reported 88,871 input tokens. Search now
previews long matching lines and caps content output with explicit truncation and
narrowing instructions, while counting full source matches. A Unicode regression
also exposed the binary detector cutting a valid UTF-8 character at its 8,000-byte
sample boundary; sampling now ends at a character boundary. Evidence is recorded in
`artifacts/search-context-diagnosis.json` and `artifacts/native-login-check.json`.

Continued observation exposed three additional loops. Historical cognition notes
were appended after the current request and described failed past invocations as
outstanding commands; they now precede the current request and retain their past
tense. Different Playwright errors shared the same final report line and were
counted as the same failure; matching now uses the actual diagnostic and waiting
locator. Live supervisor CONTINUE decisions could contain useful advice that the
running worker never received. Optional guidance now enters native workers between
tool rounds and is also saved for the next handoff. Tests verify tool/result ordering,
claim preservation, duplicate suppression, and isolation between workers.

The owner changed the supervisor to Claude CLI Sonnet during this observation;
the executor remained the configured Qwen model. The requirements-only reviewer
also made unsupported runtime claims about selectors. Its instructions now limit
that review to explicit owner conflicts and leave runtime diagnosis to inspection.
Incomplete corrections receive one response-only repair, retaining the owner text.
Progress evidence is refreshed after the asynchronous requirements comparison.

The source server has `/usr/local/bin/wp`; the copied laptop runtime had the PHAR
but no `wp` command on PATH. A wrapper in the private replay runtime restores that
environment prerequisite. This is an observer setup correction, outside extension
source, and is recorded separately from autonomous task progress. At the 14:30 UTC
checkpoint task 29 remains active and only 28/49 tasks are verified. The JavaScript
suite passes 123 cases and `go test ./...` passes; these are extension regressions,
not evidence that the copied application queue has finished.

The owner clarified that execution must use models runnable on the Strix Halo
128 GB machine, and authorized installing additional local models. An attempted
Sonnet executor comparison had been rejected by the provider catalog before task
execution; that binding and the temporary catalog change were reverted. No
Anthropic execution result is counted in this evaluation. The supervisor retains
the owner's existing Sonnet assignment.

SSH inspection confirmed Ryzen AI MAX+ 395, 124 GiB usable RAM, and Lemonade 11.6.0.
Qwen3-Coder-Next Q6_K was already downloaded (61.1 GB), as were smaller Qwen3.6 and
Qwen3.8 candidates. After the copied queue stopped and the old model showed zero
active/deferred requests, the observer unloaded Qwen3-Next and loaded the existing
Coder model through Lemonade. Saved model recipes and downloaded weights were
preserved. The private replay resumed with that local executor at 14:49 UTC.
Loaded memory was about 86 GiB used, 38 GiB available, and unchanged swap usage.
Initial reported throughput was 342 prompt tokens/s and 44 generated tokens/s.
The coder found actual field names by inspecting the renderer and schema, but
task 29 was still unverified at this checkpoint. Model and observer interventions
are recorded in `artifacts/local-model-comparison.json` and the harness log.
