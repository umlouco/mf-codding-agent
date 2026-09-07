import * as cp from 'child_process';
import type * as vscode from 'vscode';
import { resolveCoreBinary, workspaceRoot } from '../detect';
import { killTree, type ActivityRecord } from './agents';
import { getActiveQueue } from './registry';
import { loadTestingEnvironment, testingProcessEnvironment } from './testingEnvironment';

/** Execute the recorded check through the same portable shell used by workers.
 * The script goes through stdin unchanged, never through a second shell's quoting.
 */
export async function runVerificationCommand(
  context: vscode.ExtensionContext,
  command: string,
  onEvent: (method: string, params: any) => void,
  onAbort: (abort: () => void) => void,
  onActivity?: (activity: ActivityRecord) => void,
): Promise<string> {
  const binary = resolveCoreBinary(context).path;
  const root = workspaceRoot();
  if (!binary || !root) throw new Error('Verification requires the core binary and an open workspace.');
  const queue = getActiveQueue?.();
  const environment = queue ? testingProcessEnvironment(await loadTestingEnvironment(context, queue)) : {};
  const id = `required-command-${Date.now()}`;
  onEvent('stream/tool', { id, name: 'unix', status: 'running', input: { command } });
  const started = Date.now();
  const activity = () => onActivity?.({ phase: 'tool',
    detail: `required verification command running for ${Math.round((Date.now() - started) / 1000)}s`, at: Date.now() });
  activity();
  const timer = setInterval(activity, 5000);
  try {
    const result = await new Promise<{ output: string; isError: boolean }>(resolve => {
      const child = cp.spawn(binary, ['sh', '--json', '--dir', root, '--timeout', '10m'],
        { cwd: root, env: { ...process.env, ...environment, MFAGENT_QUEUE_ROLE:'executor' }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', cancelled = false, overflow = false, timedOut = false;
      // Also bound the process tree: a child inheriting stdout can outlive the
      // shell's own timeout and otherwise keep this verification promise open.
      const deadline = setTimeout(() => { timedOut = true; killTree(child.pid); }, 610_000);
      onAbort(() => { cancelled = true; killTree(child.pid); });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 1_000_000) { overflow = true; stdout = stdout.slice(0, 1_000_000); killTree(child.pid); }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.stdin.on('error', () => { /* Process error/close supplies the outcome. */ });
      child.on('error', error => { clearTimeout(deadline); resolve({ output: error.message, isError: true }); });
      child.on('close', code => {
        clearTimeout(deadline);
        if (cancelled || overflow || timedOut) {
          resolve({ output: cancelled ? 'Verification command cancelled.' : timedOut
            ? 'Verification command exceeded its execution timeout.' : 'Verification output exceeded the capture limit.', isError: true });
          return;
        }
        try {
          const value = JSON.parse(stdout);
          if (!Number.isInteger(value.code) || typeof value.output !== 'string') throw new Error('Invalid command result');
          resolve({ output: `exit=${value.code} cwd=${root}\n${value.output.slice(0, 16000)}${value.error ? '\n' + value.error : ''}`,
            isError: code !== 0 || value.code !== 0 || value.invalid === true || value.timedOut === true });
        } catch {
          resolve({ output: `The core did not return a valid command result. ${stderr || stdout.slice(0, 8000)}`, isError: true });
        }
      });
      child.stdin.end(command);
    });
    onEvent('stream/tool', { id, name: 'unix', status: result.isError ? 'error' : 'ok', output: result.output });
    return result.output;
  } finally { clearInterval(timer); }
}
