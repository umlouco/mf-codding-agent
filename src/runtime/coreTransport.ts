import * as cp from 'child_process';
import * as readline from 'readline';

export interface Disposable { dispose(): void }
export interface Output { appendLine(line: string): void }
export class Signal<T> implements Disposable {
  private listeners = new Set<(value: T) => unknown>();
  readonly event = (listener: (value: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void { for (const listener of this.listeners) listener(value); }
  dispose(): void { this.listeners.clear(); }
}
export interface TransportOptions {
  binary: string | (() => string);
  cwd: string | (() => string);
  args?: string[];
  output: Output;
  requestTimeoutMs?: number;
}
type Pending = { resolve(value: any): void; reject(error: Error): void; timer?: NodeJS.Timeout };

/** Host-independent JSON-RPC transport shared by editor and headless clients. */
export class CoreTransport implements Disposable {
  private proc?: cp.ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: any) => Promise<any>>();
  private notifications = new Set<(method: string, params: any) => void>();
  private nextId = 0;
  private disposed = false;
  readonly onDidExit = new Signal<number | null>();
  constructor(private readonly options: TransportOptions) {}
  get running(): boolean { return !!this.proc && this.proc.exitCode === null && !this.proc.killed; }
  onNotification(handler: (method: string, params: any) => void): Disposable {
    this.notifications.add(handler);
    return { dispose: () => { this.notifications.delete(handler); } };
  }
  onRequest(method: string, handler: (params: any) => Promise<any>): void { this.handlers.set(method, handler); }
  async start(): Promise<void> {
    if (this.disposed) throw new Error('Core transport disposed');
    if (this.starting) return this.starting;
    if (this.running) return;
    const resolve = (value: string | (() => string)) => typeof value === 'function' ? value() : value;
    const binary = resolve(this.options.binary);
    this.options.output.appendLine(`[core] starting ${binary}`);
    const proc = cp.spawn(binary, this.options.args ?? [], {
      cwd: resolve(this.options.cwd), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', line => { if (this.proc === proc) this.handleLine(line, proc); });
    proc.stderr.on('data', data => this.options.output.appendLine(`[core:stderr] ${String(data).trimEnd()}`));
    proc.stdin.on('error', error => { if (this.proc === proc) this.fail(error); });
    proc.on('error', error => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.fail(new Error(`Core could not start: ${error.message}`));
    });
    proc.on('close', code => {
      lines.close();
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.fail(new Error(`Core exited (${code})`));
      this.onDidExit.fire(code);
    });
    this.starting = new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', error => reject(new Error(`Core could not start: ${error.message}`)));
    });
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(error);
    }
    this.pending.clear();
  }
  private handleLine(line: string, proc: cp.ChildProcessWithoutNullStreams): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message ?? 'Core error'));
      else pending.resolve(msg.result);
    } else if (msg.method && msg.id != null) {
      const handler = this.handlers.get(msg.method);
      const respond = (data: object) => {
        if (this.proc === proc) this.write({ jsonrpc: '2.0', id: msg.id, ...data });
      };
      if (!handler) respond({ error: { code: -32601, message: `No handler for ${msg.method}` } });
      else Promise.resolve().then(() => handler(msg.params))
        .then(result => respond({ result }))
        .catch(error => respond({ error: { code: -32000, message: String(error.message ?? error) } }));
    } else if (msg.method) {
      for (const handler of this.notifications) {
        try { handler(msg.method, msg.params); }
        catch (error) { this.options.output.appendLine(`[core] notification error: ${error}`); }
      }
    }
  }
  private write(value: unknown): void {
    if (!this.running) throw new Error('Core stopped');
    this.proc!.stdin.write(JSON.stringify(value) + '\n');
  }
  async request<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (!this.running || this.starting) await this.start();
    if (this.disposed || !this.running) throw new Error('Core stopped');
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timeout = this.options.requestTimeoutMs ?? 0;
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Core request timed out: ${method}`)); this.stop();
      }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params: unknown = {}): void {
    if (this.running) this.write({ jsonrpc: '2.0', method, params });
  }
  stop(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.fail(new Error('Core stopped'));
    if (!proc) return;
    proc.stdin.end();
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && proc.pid) {
        const killer = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => { proc.kill(); });
      } else proc.kill();
    }, 1500);
    proc.once('close', () => clearTimeout(timer));
  }
  dispose(): void { this.disposed = true; this.stop(); this.onDidExit.dispose(); }
}
