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
  regressions exercise the real portable shell.
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

The live replay is still under observation. A queue advancing after a false pass
is not evidence of success, and the remaining application tasks have not yet been
established as complete. Local reloads while developing fixes are recorded in the
observer log and must be distinguished from autonomous uninterrupted execution.
