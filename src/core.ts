import * as cp from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { resolveCoreBinary } from './detect';
import { buildCoreConfig, CoreConfig } from './providers/payload';
import { getStore } from './providers/instance';

/**
 * CoreClient owns the lifetime of the compiled Go backend and speaks
 * newline-delimited JSON-RPC 2.0 to it over stdio. Everything the extension
 * does beyond rendering goes through here.
 */

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  /** Which spawned process this request was sent to. See `generation`. */
  gen: number;
};

export type NotificationHandler = (method: string, params: any) => void;
export type RequestHandler = (params: any) => Promise<any>;

export type { CoreConfig };

export interface InitResult {
  version: string;
  provider: string;
  model: string;
  tools: string[];
  memory: boolean;
  memoryPath?: string;
  visionModel?: string;
  embeddingModel?: string;
  mcp?: string[];
  warnings?: string[];
}

export class CoreClient implements vscode.Disposable {
  private proc: cp.ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notifyHandlers: NotificationHandler[] = [];
  private requestHandlers = new Map<string, RequestHandler>();
  private disposed = false;
  private restarts = 0;
  /**
   * Bumped on every spawn.
   *
   * A restart ends the old process's stdin and immediately spawns a new one, so
   * for a moment two children exist: one draining, one live. Their `exit` and
   * `line` events land on the same client, and without a generation stamp the
   * dying process's handlers clobber the live one's — rejecting its in-flight
   * `initialize` and clearing its handle. Every callback is scoped to the
   * generation that produced it.
   */
  private generation = 0;

  readonly onDidExit = new vscode.EventEmitter<number | null>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  onNotification(h: NotificationHandler): vscode.Disposable {
    this.notifyHandlers.push(h);
    return new vscode.Disposable(() => {
      const i = this.notifyHandlers.indexOf(h);
      if (i !== -1) {
        this.notifyHandlers.splice(i, 1);
      }
    });
  }

  /** Register a handler for requests the core makes of us (permission prompts). */
  onRequest(method: string, h: RequestHandler): void {
    this.requestHandlers.set(method, h);
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  private resolveBinary(): string {
    const found = resolveCoreBinary(this.context);
    if (found.path) {
      return found.path;
    }
    throw new Error(
      `Could not find the mfcore binary. Looked in:\n${found.searched.join('\n')}\n\n` +
        `Build it with: npm run build:core`,
    );
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    // resolveCoreBinary already restores the executable bit lost when a VSIX
    // built on Windows extracts on Linux/macOS — see detect.ts's ensureExecutable.
    const bin = this.resolveBinary();
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(bin);

    const gen = ++this.generation;
    this.output.appendLine(`[core] starting ${bin}`);
    const proc = cp.spawn(bin, [], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.handleLine(line, gen));

    proc.stderr.on('data', (d: Buffer) => {
      this.output.appendLine(`[core:stderr] ${d.toString().trimEnd()}`);
    });

    proc.on('exit', (code) => {
      // Requests are keyed by generation, so a superseded process only fails
      // the calls that were actually sent to it.
      for (const [id, p] of [...this.pending]) {
        if (p.gen === gen) {
          this.pending.delete(id);
          p.reject(new Error('The MF Agent core exited.'));
        }
      }

      // We already moved on: this is a process we shut down on purpose, and
      // its death says nothing about the one now running.
      if (this.proc !== proc) {
        this.output.appendLine(`[core] previous process exited with code ${code}`);
        return;
      }

      this.output.appendLine(`[core] exited with code ${code}`);
      this.proc = undefined;
      this.onDidExit.fire(code);

      // Crash-loop guard: restart a few times, then stop and tell the user.
      if (!this.disposed && code !== 0) {
        if (this.restarts < 3) {
          this.restarts++;
          this.output.appendLine(`[core] restarting (attempt ${this.restarts}/3)`);
          setTimeout(() => {
            this.start().catch((e) => this.output.appendLine(`[core] restart failed: ${e}`));
          }, 750);
        } else {
          void vscode.window
            .showErrorMessage(
              'The MF Agent core keeps exiting. See the log for details.',
              'Show Log',
            )
            .then((pick) => {
              if (pick) {
                this.output.show();
              }
            });
        }
      }
    });

    proc.on('error', (err) => {
      this.output.appendLine(`[core] spawn error: ${err.message}`);
      // A process that never started emits no 'exit', so nothing else will
      // settle the calls waiting on it.
      for (const [id, p] of [...this.pending]) {
        if (p.gen === gen) {
          this.pending.delete(id);
          p.reject(new Error(`The MF Agent core could not start: ${err.message}`));
        }
      }
      if (this.proc === proc) {
        this.proc = undefined;
      }
    });

    // Wait for the spawn to actually succeed. Returning before this is what
    // turns a failure to launch — a missing executable bit on a remote host,
    // say — into an `initialize` that hangs forever instead of an error.
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', (err: Error) =>
        reject(new Error(`The MF Agent core could not start: ${err.message}`)),
      );
    });
  }

  private handleLine(line: string, gen: number): void {
    if (!line.trim()) {
      return;
    }
    // Ids restart from 1 with each process, so a late line from a draining
    // child could otherwise resolve the new child's request of the same id.
    if (gen !== this.generation) {
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.output.appendLine(`[core] unparseable line: ${line.slice(0, 500)}`);
      return;
    }

    // A response to something we sent.
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? 'core error'));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // A request from the core (permission prompts).
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        this.write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `no handler for ${msg.method}` },
        });
        return;
      }
      handler(msg.params)
        .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result }))
        .catch((e: Error) =>
          this.write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: e.message },
          }),
        );
      return;
    }

    // A notification.
    if (msg.method) {
      for (const h of this.notifyHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (e) {
          this.output.appendLine(`[core] notification handler threw: ${e}`);
        }
      }
    }
  }

  private write(obj: unknown): void {
    if (!this.proc) {
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      this.output.appendLine(`[core] write failed: ${e}`);
    }
  }

  async request<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (!this.running) {
      await this.start();
    }
    const id = this.nextId++;
    const gen = this.generation;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, gen });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * `overrides` lets a caller run this core on a different model than the one
   * in user settings. The core binds one provider for its whole lifetime, so a
   * second model means a second CoreClient — that is how the task queue gives
   * the Supervisor and the Execution worker separate brains.
   */
  async initialize(overrides: Partial<CoreConfig> = {}): Promise<InitResult> {
    const payload = await buildCoreConfig(getStore());
    this.restarts = 0;
    // A worker overrides Coding, but still needs the configured Vision provider.
    const providers = new Map(payload.providers.map((provider) => [provider.id, provider]));
    for (const provider of overrides.providers ?? []) providers.set(provider.id, provider);
    return this.request<InitResult>('initialize', { ...payload, ...overrides, providers: [...providers.values()] });
  }

  async restart(overrides: Partial<CoreConfig> = {}): Promise<InitResult> {
    this.stopProcess();
    await this.start();
    return this.initialize(overrides);
  }

  /** Stops the child process without disposing the client. */
  stop(): void {
    this.stopProcess();
  }

  private stopProcess(): void {
    if (!this.proc) {
      return;
    }
    // Detaching the handle first is what marks this process as superseded:
    // its exit handler checks identity against `this.proc`.
    const p = this.proc;
    this.proc = undefined;
    try {
      p.stdin.end();
    } catch {
      /* already closed */
    }
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }, 1500);
    p.once('exit', () => clearTimeout(timer));
  }

  dispose(): void {
    this.disposed = true;
    this.stopProcess();
    this.onDidExit.dispose();
  }
}
