import * as vscode from 'vscode';
import { CoreClient } from './core';

/**
 * Runs the core's `run_shell` tool in a real VS Code terminal instead of a
 * process the core spawns for itself — see Env.EditorTerminal in
 * core/internal/tools/registry.go.
 *
 * The core can already spawn PowerShell perfectly well, so this is not about
 * being able to run a command. It is about running it in the same place the
 * user runs theirs. A terminal VS Code owns starts from the user's configured
 * shell and profile: their PATH, their nvm or pyenv shims, their active
 * virtualenv, their git credential helper, the proxy variables their company
 * sets. A bare spawn from the extension host inherits none of that reliably,
 * which is why "works in my terminal, fails from the agent" is such a common
 * and such an expensive thing to debug.
 *
 * The second half is visibility. A build that runs inside the core is a
 * progress spinner and, eventually, whatever the model chooses to quote. The
 * same build here scrolls in a tab the user can watch while it runs, stop with
 * Ctrl-C, and scroll back through afterwards — and what they read is the real
 * output, not a summary of it.
 *
 * This needs VS Code's shell integration, which is what supplies the command's
 * output stream and its exit code. It activates asynchronously and can fail to
 * activate at all for an unusual shell, so everything here is conditional:
 * `isAvailable` decides at startup whether the core is even told the terminal
 * exists, and a command that starts but cannot be tracked reports an unknown
 * exit code rather than guessing zero.
 */

/** How long to wait for shell integration to come up in a fresh terminal. */
const INTEGRATION_TIMEOUT_MS = 5000;

interface ExecParams {
  cwd: string;
  command: string;
  timeoutMs: number;
}

interface ExecResult {
  output: string;
  /** Null when the terminal could not report one — never coerce this to 0. */
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Whether this VS Code can run commands for us. `executeCommand` on
 * `shellIntegration` is the API the whole path is built on; it was finalized in
 * 1.93, and on an older host the property is simply absent. Checking for the
 * capability rather than comparing version strings means a user on an
 * unexpected build gets the fallback instead of a crash.
 */
export function isAvailable(): boolean {
  return typeof vscode.window.onDidChangeTerminalShellIntegration === 'function';
}

let terminal: vscode.Terminal | undefined;

/**
 * Commands run one at a time.
 *
 * A terminal is a single stream of text with a single prompt, and this one is
 * shared by everything in the window. Two commands sent into it concurrently
 * interleave their output and neither result can be attributed to either
 * command — so requests queue behind each other here rather than racing. The
 * core already serialises mutating tools within one turn; this covers the case
 * it cannot see, which is two chat sessions live in the same core process.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // Keep the chain alive after a rejection: the failure belongs to the caller
  // that asked for it, not to every command queued behind it.
  queue = next.catch(() => undefined);
  return next;
}

/** Registers the `shell/exec` handler the core calls back into. */
export function registerEditorTerminalHandlers(client: CoreClient): void {
  client.onRequest('shell/exec', async (params) =>
    serialize(() => handleExec(params as ExecParams)),
  );
}

/** Drops the cached terminal, so the next command opens a fresh one. */
export function disposeTerminal(): void {
  terminal?.dispose();
  terminal = undefined;
}

/**
 * The terminal every command runs in, created on first use and reused after
 * that. Reuse is deliberate: a tab per command would bury the workspace in
 * terminals, and a single named one gives the user one place to look and a
 * scrollback that reads as a session rather than as fragments.
 */
async function getTerminal(cwd: string): Promise<vscode.Terminal> {
  if (terminal && terminal.exitStatus === undefined) {
    return terminal;
  }
  terminal = vscode.window.createTerminal({
    name: 'MF Agent',
    cwd,
    iconPath: new vscode.ThemeIcon('robot'),
    isTransient: true,
  });
  await waitForShellIntegration(terminal);
  return terminal;
}

/**
 * Waits for shell integration to activate, and resolves either way.
 *
 * Activation is asynchronous — VS Code has to inject its hooks and see the
 * shell come back — so a command sent immediately after createTerminal would
 * miss it. Resolving on timeout rather than rejecting is the point: a shell
 * that never activates is a shell we can still run in, just not one we can read
 * an exit code out of, and that is the caller's decision to make.
 */
function waitForShellIntegration(term: vscode.Terminal): Promise<void> {
  if (term.shellIntegration) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, INTEGRATION_TIMEOUT_MS);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) {
        clearTimeout(timer);
        sub.dispose();
        resolve();
      }
    });
  });
}

async function handleExec(params: ExecParams): Promise<ExecResult> {
  const term = await getTerminal(params.cwd);
  term.show(/* preserveFocus */ true);

  const integration = term.shellIntegration;
  if (!integration) {
    // The terminal exists but VS Code cannot see into it. Running the command
    // anyway would produce output nobody can capture and a result nobody can
    // check, which reads to the model as a silent success. Failing here sends
    // the core back to spawning the command itself, where at least the exit
    // code is real.
    throw new Error(
      'the terminal has no shell integration, so its output and exit code cannot be read',
    );
  }

  // cd first when the command targets a different directory than the terminal
  // was opened in. Sending it as its own execution keeps it out of the output
  // the caller reads back.
  if (params.cwd && params.cwd !== terminalCwd(term)) {
    integration.executeCommand(cdCommand(params.cwd));
  }

  const execution = integration.executeCommand(params.command);
  return collect(execution, params.timeoutMs);
}

/**
 * Reads a running execution to completion, or until the deadline.
 *
 * Output and exit code arrive from two different places — the stream on the
 * execution, and the end event on the window — and either can finish first, so
 * both are awaited rather than assumed to be ordered.
 */
async function collect(
  execution: vscode.TerminalShellExecution,
  timeoutMs: number,
): Promise<ExecResult> {
  let settle: (r: ExecResult) => void;
  const done = new Promise<ExecResult>((resolve) => {
    settle = resolve;
  });

  const chunks: string[] = [];
  let finished = false;

  const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
    if (e.execution !== execution) {
      return;
    }
    finished = true;
    endSub.dispose();
    clearTimeout(timer);
    // Drain whatever the stream has not yielded yet before settling: the end
    // event routinely arrives before the last chunk does, and settling on it
    // alone truncates the tail of every command — including, reliably, the
    // error message at the end of a failed build.
    void reading.then(() =>
      settle({
        output: stripAnsi(chunks.join('')),
        exitCode: e.exitCode ?? null,
        timedOut: false,
      }),
    );
  });

  const timer = setTimeout(() => {
    if (finished) {
      return;
    }
    endSub.dispose();
    // The command keeps running — it is the user's terminal, and killing it
    // from under them is not ours to do. What we report is that we stopped
    // waiting, which run_shell passes on verbatim.
    settle({ output: stripAnsi(chunks.join('')), exitCode: null, timedOut: true });
  }, Math.max(1000, timeoutMs));

  const reading = (async () => {
    try {
      for await (const chunk of execution.read()) {
        chunks.push(chunk);
      }
    } catch {
      // A stream that ends abruptly still leaves usable output behind.
    }
  })();

  return done;
}

/** The terminal's own working directory, when VS Code knows it. */
function terminalCwd(term: vscode.Terminal): string | undefined {
  const cwd = term.shellIntegration?.cwd;
  return cwd instanceof vscode.Uri ? cwd.fsPath : undefined;
}

/**
 * `cd` for the user's shell. PowerShell and sh disagree about how to quote a
 * path, and a workspace path with a space or a quote in it is exactly the case
 * that silently changes to the wrong directory otherwise.
 */
function cdCommand(cwd: string): string {
  if (process.platform === 'win32') {
    return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`;
  }
  return `cd '${cwd.replace(/'/g, `'\\''`)}'`;
}

/**
 * Strips the escape sequences a terminal stream carries.
 *
 * `read()` yields what the shell actually wrote, colour codes and cursor moves
 * included. Those are invisible in a terminal and very visible in a model's
 * context window, where they cost tokens and turn a one-line error into an
 * unreadable one. VS Code's own shell-integration markers (OSC 633) are
 * stripped too — they are protocol, not output.
 */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][0-9;]*;?[^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC, including 633
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI: colour, cursor movement
    .replace(/\x1b[@-Z\\-_]/g, '') // remaining two-character escapes
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}
