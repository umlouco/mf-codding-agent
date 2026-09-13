# Running the queue from source

The Node entry point loads the production TypeScript queue, provider adapter,
orchestrator and verifier. It supplies a small set of editor services and runs
the compiled Go tools directly. It does not install or activate a VS Code extension.

Build with `npm ci` and `npm run build:core`. Node 22.13 or newer is required
when using the built-in SQLite driver. Claude CLI must be installed and authenticated.

```powershell
node scripts/queue-runner.cjs plan --workspace C:\path\to\site --goal-file C:\outside\goal.txt --model sonnet
node scripts/queue-runner.cjs run --workspace C:\path\to\site --model sonnet
node scripts/queue-runner.cjs status --workspace C:\path\to\site
```

To keep Claude CLI for planning while using an HTTP model for supervision and
execution, add `--worker-url https://your-server/api/v1 --worker-model MODEL`
to the run command. Supply its API key through `MFAGENT_WORKER_API_KEY`.
Phase exploration, scope plans and failure replacement plans use the planner profile; ordinary supervisor decisions and
independent verification reasoning use the worker profile. CLI planning defaults
to medium effort, configurable with `--effort`.

`--worker-all` binds planner and supervisor to the same HTTP worker as execution,
so a run does not depend on the Claude CLI account (its monthly spend limit
otherwise stops planning and supervision mid-run). The worker endpoint, model and
key are also auto-detected from `MFAGENT_WORKER_URL/MODEL/API_KEY`,
`OPENROUTER_API_KEY` or `OPENAI_API_KEY`, and `repo/.env` is loaded for missing
keys. `run` refuses to start when planner, supervisor or executor has no usable
provider, and a configuration or authentication fault stops the run instead of
being read as a failed task that earns endless decomposition.

## Local WordPress on XAMPP

`scripts/wp-xampp.cjs` takes the fragile local-setup work away from the model.
It uses `C:\www\php\php.exe` and `C:\www\mysql\bin\mysql.exe` (root, no password):

```powershell
node scripts/wp-xampp.cjs bootstrap --site C:\www\htdocs\site --url http://localhost/site
node scripts/wp-xampp.cjs probe     --site C:\www\htdocs\site --url http://localhost/site
node scripts/wp-xampp.cjs activate  --site C:\www\htdocs\site --plugin mf-newsletter
```

`bootstrap` creates the database, writes a working `wp-config.php`, installs
WordPress only when the tables are absent, ensures an administrator and sample
posts, and fails unless the site serves a non-empty page. It is idempotent. When
a run's workspace contains `wp-load.php`, the source host injects these exact
facts and commands into the planning, supervision and execution prompts, and the
generated admin password is available through `MFAGENT_CREDENTIAL_PASSWORD` and
`<site>/.mfagent/wp-admin.json`.
Model responses have no elapsed-time deadline. Planning, supervision and verification
wait for completion or an explicit stop request. The source host also disables the
transport idle timeout; activity heartbeats continue while the model is working.
In the editor, `mfagent.llm.idleMinutes: 0` disables transport idle cancellation.

`plan` refuses to overwrite existing tasks. Plans and task changes come from
the extension's planning and supervisor code. `run` resumes persisted progress.
To stop cleanly, send Ctrl+C or create `.mfagent/headless.stop` in the target
workspace. Remove that stop-request file before resuming.
Shutdown cancels owned processes and drains their callbacks before closing SQLite.
Planning and status hosts create the orchestrator only when execution is requested;
closing an inspection host cannot requeue another host's running task.

Planning detects an explicitly identified testing URL and credentials in the
owner's prompt, including `credentials username / password` and separately
labeled username/password fields. It stores them through the existing testing
settings and redacts passwords before planning logs, model calls and goal storage.
Existing manually selected settings remain authoritative. Ambiguous multiple URLs
are not guessed; use the Testing environment UI or `--url` to select the target.

The source host keeps credentials in memory. On subsequent runs, supply
`MFAGENT_CREDENTIAL_USERNAME` and `MFAGENT_CREDENTIAL_PASSWORD` in the environment.
The VS Code host continues to use its existing SecretStorage and manual settings UI.
Do not commit credentials in goal files or scripts.

When a queue has both a testing URL and credential names, the verifier host
always runs `playwright_test`, independently of the LLM's proposed checks. An
unavailable or failing suite prevents PASS. This gate supplements the task's
acceptance checks; it does not establish visual parity or authentication by itself.
Tests must contain those assertions. Verification planning and reporting receive
distinct system instructions: planning returns executable checks, while reporting
judges the host's receipts. A rejected plan's correction includes the required JSON
and assertion schemas again.
Verification shell steps use the portable POSIX runtime, including on Windows.
Both planning prompts state this explicitly even when executor feedback describes
PowerShell. Plans containing PowerShell cmdlets are rejected before execution so
their assertions can be translated without confusing a shell error with a site defect.
Task planners and supervisor recovery also receive this contract when authoring
saved verification commands. Executor development-shell guidance does not override it.
Retry and replacement handoffs identify rejected decision-only worker replies instead
of repeating their role prose and decision schema. Reported observations and unfinished
checks from older replies remain available as unverified evidence; bounded fields retain
valid JSON framing. Valid executor completion reports remain intact.
The mandatory check runs before verifier model planning. Its receipt is retained
while independent task-specific checks run, including when the suite is missing.
This allows a failed assertion about an assigned implementation requirement to
support recovery without treating an unavailable testing tool as an application
defect. The mandatory failure still prevents PASS. Its receipt is reused within
that verification session instead of rerunning the unchanged prerequisite.

Set `MFAGENT_PLAYWRIGHT_ROOT` to an external Playwright project to keep test code,
dependencies and artifacts out of the application repository. The planner receives
that directory and the Go Playwright tools use it. Tests read `MFAGENT_TEST_URL`
and the credential environment references. No implicit package download occurs
when the verifier runs a suite.
File tools also allow that explicitly configured external project directory while
rejecting sibling paths and symlink escapes. Existing test ownership rules still apply.

Planning reviews its draft for independently verifiable outcomes before returning
phases. TDD assertions and their implementations belong in the same phase and task;
bootstrap setup includes the first passing tests. Large discovery indexes are sent
as bounded directory catalogs; the host retains the complete index for enumeration.
Replacement workers receive the archived parent report in their execution prompt,
so recovering prior work does not require querying the queue database.
Replacement planning also keeps the first executable harness tests with bootstrap
implementation and requires assertions against real configuration values.
The host rejects a first mandatory-suite replacement that omits a named executable
test or a passing-suite outcome and asks the planner to repair its own proposal.
Planner instructions require registered Playwright test cases even for assertions
that only inspect files. The host rejects the observed contradictory instruction
to run Playwright while using only Node fs/path and forbidding the runner import.
An explicit model report of a very long, nested, corrupted prompt requests planner
decomposition from executor, verifier or supervisor streams. Late results cannot
override that request; a planner already producing the split is allowed to finish.
Supervisor `SPLIT` and `SPLIT_TASK` decisions also request the configured planner.
They need a concrete reason, not replacement task definitions. The parent remains
fenced until the planner produces and validates its complete replacement.
Automatic progress reviews wait for a completed tool outcome from the current
executor attempt. Startup signals and transport heartbeats do not start another
model request; the immediate prompt-overload handler still applies.
The OpenAI-compatible adapter accepts complete textual `tool_calls` envelopes
from local models when every call names an advertised tool and has valid object
arguments. These calls use the normal execution checks and tool-result protocol.
An executor returning only command arguments receives one request to name the tool
correctly. Anonymous commands are not executed; a second malformed response is
reported as a tool-protocol error for normal queue recovery.
Tool-enabled requests use automatic tool selection so an executor can also report
a concrete blocker. Only verification receipts establish whether the work passed.
Queue executors also receive their implementation role in the system message.
Acceptance checks and historical verifier reports remain requirements and evidence,
and do not change that role. Verifiers and supervisors retain their own system policies.
Claude planner calls expose only Read, Glob, Grep, WebFetch and WebSearch through
the CLI's tool list, with explicit unattended approval for those inspection tools.
They do not receive shell, editing, delegation or MCP tools. Planning from supplied
text alone continues to use no tools. The configured test target remains available
in the planning context, while executors perform implementation and test runs.
