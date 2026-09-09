import * as cp from 'child_process';
import type { Output } from './coreTransport';
import type { Task } from '../queue/db';

export interface CheckReceipt {
  command: string;
  executedCommand: string;
  exitCode: number | null;
  isError: boolean;
  output: string;
}
export type CheckRunner = (task: Task) => Promise<CheckReceipt>;
export interface CommandConfig {
  coreBinary: string;
  workspaceRoot: string;
  sourceRoot?: string;
  commandTimeoutMs?: number;
}

/** Only an explicitly configured source root is relocated; the original contract stays intact. */
export function mapReplayCommand(command: string, config: CommandConfig): string {
  if (!config.sourceRoot) return command;
  const source = config.sourceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const target = config.workspaceRoot.replace(/\\/g, '/');
  // Never invent shell quoting when a path is embedded in arbitrary imported script syntax.
  if (!/^[A-Za-z0-9_./:~-]+$/.test(target)) {
    throw new Error('Replay command mapping requires a shell-safe workspace path; supply a reviewed command adapter for paths with spaces or metacharacters');
  }
  const pattern = source.split('/').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  return command.replace(new RegExp(pattern + '(?=[\\\\/\\s\'";]|$)', 'gi'), target);
}

/** Execute the recorded check through mfcore's portable shell, without asking a model. */
export function createCommandRunner(config: CommandConfig, output: Output, signal?: AbortSignal): CheckRunner {
  return async task => {
    if (signal?.aborted) throw new Error('Required command cancelled');
    const command = task.solutionVerifyCommand;
    const executedCommand = mapReplayCommand(command, config);
    const timeout = Math.min(600000, Math.max(1, config.commandTimeoutMs ?? 600000));
    output.appendLine(`[host-check:${task.id}] ${JSON.stringify({ command, executedCommand })}`);
    return new Promise<CheckReceipt>((resolve, reject) => {
      const child = cp.spawn(config.coreBinary,
        ['sh', '--json', '--dir', config.workspaceRoot, '--timeout', `${timeout}ms`], {
          cwd: config.workspaceRoot, windowsHide: true, detached: process.platform !== 'win32',
          env: { ...process.env, MFAGENT_QUEUE_ROLE: 'validator' }, stdio: ['pipe', 'pipe', 'pipe'],
        });
      let stdout = '', stderr = '', interrupted = '';
      const stop = (reason: string) => {
        interrupted = reason;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          const killer = cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => child.kill());
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
      };
      const timer = setTimeout(() => stop('Required command exceeded its deadline'), timeout + 10000);
      const abort = () => stop('Required command cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => {
        if (stdout.length + data.length > 1000000) stop('Required command output exceeded capture limit');
        else stdout += data;
      });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        const receipt: CheckReceipt = { command, executedCommand, exitCode: null, isError: true, output: interrupted || stderr };
        if (!interrupted) {
          try {
            const value = JSON.parse(stdout);
            if (!Number.isInteger(value.code) || typeof value.output !== 'string') throw new Error('Invalid command envelope');
            receipt.exitCode = value.code;
            receipt.isError = code !== 0 || value.code !== 0 || value.invalid === true || value.timedOut === true;
            receipt.output = value.output + (value.error ? `\n${value.error}` : '');
          } catch { receipt.output = `Core did not return valid command evidence. ${stderr || stdout.slice(0, 8000)}`; }
        }
        output.appendLine(`[host-check:${task.id}] ${JSON.stringify(receipt)}`);
        resolve(receipt);
      });
      child.stdin.end(executedCommand);
    });
  };
}
