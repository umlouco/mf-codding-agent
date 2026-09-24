import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { workspaceRoot } from '../detect';
import { ResolvedRole } from '../providers/store';
import { killTree, Role, RunOptions, TurnResult } from './agents';
import { Usage } from './db';
import { getActiveQueue } from './registry';
import { loadTestingEnvironment, testingProcessEnvironment, testingPrompt, redactTestingSecrets } from './testingEnvironment';
import { getContext } from '../providers/instance';
import { cliInstructions, mcpPolicyRule } from './cliCommon';

/**
 * Runs one turn through the OpenAI Codex CLI (`codex exec`) as a subprocess,
 * instead of mfcore.
 *
 * Codex is a complete agent on its own — its own tool loop, its own MCP client,
 * its own sandbox — so, exactly like `claudeCli.ts`, this does not try to plug
 * it into mfcore's loop. It is spawned directly, one non-interactive turn per
 * call, and its `--json` JSONL event stream is translated into the same
 * `stream/text` / `stream/thinking` / `stream/tool` notifications the rest of
 * the queue already reads off `RunOptions.onEvent`.
 *
 * Event shapes were captured from a real run
 * (`codex exec --json --skip-git-repo-check --ephemeral -s read-only`), not
 * just docs: a turn emits `{"type":"thread.started"}`, then
 * `{"type":"turn.started"}`, then a series of `item.started` / `item.updated` /
 * `item.completed` events whose `item.type` is `agent_message`, `reasoning`,
 * `command_execution`, `file_change`, `mcp_tool_call`, …, and finally
 * `{"type":"turn.completed","usage":{…}}`.
 */

/** Pass through explicit effort; the chosen model decides which values it supports. */
function codexEffort(effort: string): string {
  switch (effort) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return '';
  }
}

/**
 * Spawns the Codex CLI so it works however it was installed.
 *
 * On Windows the official install is an npm global, which lands as a
 * `codex.cmd` shim — and Node cannot spawn a `.cmd` directly (CreateProcess
 * cannot run a batch file without `cmd.exe`), so a bare `spawn('codex')` fails
 * with ENOENT. `shell: true` is not the fix: Node joins the argument list
 * without quoting, so a workspace or output path containing a space is split
 * into two arguments and the CLI exits with a usage error. The reliable form
 * is `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`, where every
 * token is quoted here by hand. A native `.exe` (winget, cargo, an explicit
 * path) is spawned directly.
 */
function spawnCodex(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): cp.ChildProcessWithoutNullStreams {
  if (process.platform === 'win32' && !/\.exe$/i.test(bin)) {
    const quote = (s: string) => (/[\s"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    const line = [bin, ...args].map(quote).join(' ');
    return cp.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return cp.spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Settings' "Test" button for a Codex CLI profile: there is no endpoint to
 * ping (`listStyle: 'none'`), so this checks the one thing that actually
 * varies machine-to-machine — whether the binary resolves at all — by
 * running `<bin> --version`.
 */
export function testCodexCliBinary(cliPath?: string): Promise<{ ok: boolean; message: string }> {
  const bin = cliPath?.trim() || 'codex';
  return new Promise((resolve) => {
    const proc = spawnCodex(bin, ['--version'], process.cwd(), process.env);
    proc.on('error', (err) => resolve({ ok: false, message: `Could not run "${bin}": ${err.message}` }));
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, message: `Found ${out.trim() || bin}.` });
      } else {
        resolve({ ok: false, message: `"${bin} --version" exited with code ${code}.` });
      }
    });
  });
}

/**
 * A response-only turn (format repair over supplied evidence) has no tools.
 * Codex has no `--tools ""` flag, so this is stated in the prompt and the turn
 * runs in the read-only sandbox.
 */
function responseOnlyText(role: Role, opts: RunOptions): string {
  const common =
    'Review supplied text and evidence only. Return the exact requested decision schema. ' +
    'Do not investigate, call tools, or emit XML checks. Owner requirements outrank derived ' +
    'task instructions. Preserve required behavior and assertions.';
  if (opts.verificationOnly) {
    return 'You are a skilled software tester verifying one assigned task. ' +
      'Check its deliverables and acceptance conditions without expanding into sibling work. ' +
      'For a document or inventory, inspect that deliverable; do not implement the tests it lists. ' +
      'Only supplied host receipts establish results. Distinguish failed invocations from application defects. ' +
      'Preserve owner requirements and the configured testing environment. Return the requested JSON schema. ' +
      'PASS requires every assigned condition to be supported; otherwise report FAIL or INCOMPLETE with the exact gap. ' +
      'Do not repeat an unchanged failed invocation. Tools are unavailable in this response turn.';
  }
  if (role === 'supervisor') {
    return 'You are the engineering supervisor for an autonomous task queue, completing a response-only decision turn. ' +
      'Use supplied evidence; tools are unavailable. Return exactly the requested schema and action vocabulary. ' +
      'Preserve owner requirements, the assigned task scope, and independent verification requirements. ' +
      'Unfinished siblings are not defects in a committed child task. Distinguish observed application failures ' +
      'from failed invocations, missing evidence, and unsupported claims. Retain a supported diagnosis when ' +
      'repairing its format. Do not invent observations, a passing check, or an applied queue transition.';
  }
  return common;
}

export async function runCodexCliTurn(
  output: vscode.OutputChannel,
  role: Role,
  resolved: ResolvedRole,
  prompt: string,
  opts: RunOptions,
): Promise<TurnResult> {
  const bin = resolved.profile?.extra?.cliPath?.trim() || 'codex';
  const cwd = workspaceRoot() || process.cwd();
  const queue = getActiveQueue?.();
  const testing = queue ? await loadTestingEnvironment(getContext(), queue) : undefined;
  const plannerOnly = role === 'planner' || opts.planningOnly;

  // Codex reads its own `~/.codex/config.toml` for MCP servers, so this does
  // not inject a server list the way the Claude transport does; the rule is
  // stated without a connected-server list rather than naming servers Codex
  // may not have.
  const instructions = opts.formatOnly
    ? responseOnlyText(plannerOnly ? 'planner' : role, opts)
    : cliInstructions(plannerOnly ? 'planner' : role, opts, []) + mcpPolicyRule();

  // A planner/supervisor turn only inspects. A future executor turn (not
  // currently bindable to this provider) would need workspace write access.
  const sandbox =
    opts.allowTestEdits || (role === 'executor' && !opts.verificationOnly)
      ? 'workspace-write'
      : 'read-only';

  const lastMessageFile = path.join(
    os.tmpdir(),
    `mfagent-codex-${process.pid}-${Date.now()}.txt`,
  );
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    // The workspace root is the child's working directory (the spawn `cwd`
    // below); omitting -C keeps one fewer spaced path in the argument line.
    '-s', sandbox,
    '-o', lastMessageFile,
  ];
  if (resolved.model && resolved.model !== 'default') {
    args.push('-m', resolved.model);
  }
  const effort = codexEffort(resolved.effort);
  if (effort) {
    // Unquoted on purpose: Codex parses -c values as TOML and falls back to the
    // literal string, so `high` needs no quotes that would then need shell
    // escaping.
    args.push('-c', `model_reasoning_effort=${effort}`);
  }

  if (testing) {
    prompt = testingPrompt(prompt, testing);
  }
  let fullPrompt = instructions + '\n\n' + prompt;
  if (queue && testing && !opts.formatOnly && !plannerOnly) {
    fullPrompt +=
      '\n' + queue.testingContext +
      '\nRead testing_environment before testing. For Apache rewrites use apache_rewrite_check. ' +
      'Use environment variable references for credentials; never print their values.';
  }

  output.appendLine(
    `[queue:${role}] starting codex CLI (${resolved.model || 'default model'}, ${sandbox})`,
  );

  const proc = spawnCodex(bin, args, cwd, {
    ...process.env,
    MFAGENT_QUEUE_ROLE: opts.verificationOnly ? 'validator' : opts.allowTestEdits ? 'supervisor-repair' : role,
    ...(testing ? testingProcessEnvironment(testing) : {}),
  });

  // Reported on 'close' below. Without a listener here, a failure to start at
  // all -- no `codex` on PATH being the usual one -- reaches the extension
  // host as an unhandled 'error' event instead of this turn's rejection.
  let spawnError: Error | undefined;
  proc.on('error', (err: Error) => {
    spawnError = err;
  });

  // An aborted or crashed CLI closes stdin from its end mid-write; that EPIPE
  // is the turn ending, not a fault to propagate. The prompt goes in on stdin,
  // never in argv: a planner prompt carries the whole queue and would trip the
  // Windows command-line limit.
  proc.stdin.on('error', () => {});
  proc.stdin.end(fullPrompt);

  let cancelled = false;
  const cancel = () => { cancelled = true; killTree(proc.pid); };
  opts.onAbort?.(cancel);
  opts.onCancellable?.(cancel);

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += redactTestingSecrets(d.toString(), testing);
  });

  let lastAgentMessage = '';
  let failed = '';
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastActivityAt = 0;

  const activity = (detail: string) => {
    if (cancelled) return;
    const now = Date.now();
    if (!opts.onActivity || now - lastActivityAt < 3000) {
      return;
    }
    lastActivityAt = now;
    opts.onActivity({ phase: role, detail, at: now });
  };

  const handleItem = (kind: string, item: any): void => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'agent_message':
        if (kind === 'item.completed' && typeof item.text === 'string') {
          lastAgentMessage = item.text;
          opts.onEvent?.('stream/text', { delta: item.text });
          activity('writing');
        }
        return;
      case 'reasoning':
        if (kind === 'item.completed' && typeof item.text === 'string') {
          opts.onEvent?.('stream/thinking', { delta: item.text });
          activity('thinking');
        }
        return;
      case 'command_execution': {
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        opts.onEvent?.('stream/tool', {
          id,
          name: 'shell',
          status: kind === 'item.completed' ? (item.exit_code === 0 ? 'done' : 'error') : 'running',
          input: { command: item.command },
          ...(kind === 'item.completed' ? { output } : {}),
        });
        if (kind === 'item.started') {
          activity('shell');
        }
        return;
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        opts.onEvent?.('stream/tool', {
          id,
          name: 'apply_patch',
          status: kind === 'item.completed' ? 'done' : 'running',
          input: { changes },
          ...(kind === 'item.completed'
            ? { output: changes.map((c: any) => `${c?.kind ?? 'change'} ${c?.path ?? ''}`).join('\n') }
            : {}),
        });
        return;
      }
      case 'mcp_tool_call': {
        const name = item.server && item.tool ? `mcp__${item.server}__${item.tool}` : 'mcp_tool_call';
        opts.onEvent?.('stream/tool', {
          id,
          name,
          status: kind === 'item.completed' ? (item.error ? 'error' : 'done') : 'running',
          input: item.arguments ?? {},
          ...(item.result !== undefined ? { output: JSON.stringify(item.result) } : {}),
        });
        return;
      }
      default:
        // An unrecognised item type is still visible work; show it rather than
        // dropping it silently.
        if (kind === 'item.completed') {
          opts.onEvent?.('stream/tool', { id, name: String(item.type ?? 'item'), status: 'done', input: {} });
        }
        return;
    }
  };

  function handleLine(evt: any): void {
    switch (evt.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        handleItem(evt.type, evt.item);
        return;
      case 'turn.completed': {
        const u = evt.usage ?? {};
        const input = Number(u.input_tokens) || 0;
        const cached = Number(u.cached_input_tokens) || 0;
        const outputTokens = Number(u.output_tokens) || 0;
        // Codex's input_tokens includes the cached portion; keep them apart so
        // the run budget counts fresh input, not re-sent cache. output_tokens
        // already includes reasoning_output_tokens, so do not add them again.
        usage = {
          input: Math.max(0, input - cached),
          output: outputTokens,
          cacheRead: cached,
          cacheWrite: Number(u.cache_write_input_tokens) || 0,
        };
        return;
      }
      case 'turn.failed':
        failed = String(evt.error?.message ?? 'turn failed');
        return;
      case 'error':
        failed = String(evt.message ?? 'error');
        return;
      default:
        return;
    }
  }

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (cancelled || !line.trim()) {
      return;
    }
    let evt: any;
    try {
      evt = JSON.parse(line, (_key, value) => (typeof value === 'string' ? redactTestingSecrets(value, testing) : value));
    } catch {
      return;
    }
    handleLine(evt);
  });

  const started = Date.now();
  const exitCode: number = await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code ?? -1));
  });
  rl.close();

  let finalText = lastAgentMessage;
  try {
    if (fs.existsSync(lastMessageFile)) {
      const written = fs.readFileSync(lastMessageFile, 'utf8').trim();
      if (written) {
        finalText = written;
      }
    }
  } catch {
    // The streamed agent_message remains the fallback.
  } finally {
    try {
      fs.unlinkSync(lastMessageFile);
    } catch {
      // Nothing to remove.
    }
  }

  if (cancelled) {
    throw new Error('Codex CLI turn cancelled; late output was discarded.');
  }
  if (spawnError) {
    throw new Error(`could not start the codex CLI ("${bin}"): ${spawnError.message}`);
  }
  if (failed) {
    throw new Error(`codex CLI failed: ${failed}`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `codex CLI exited with code ${exitCode}` +
        (stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ''),
    );
  }
  if (!finalText.trim()) {
    throw new Error(
      `codex CLI exited (code ${exitCode}) with no agent message` +
        (stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ''),
    );
  }

  output.appendLine(
    `[queue:${role}] codex CLI turn finished in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${usage.input} in / ${usage.output} out, ${usage.cacheRead} cached)`,
  );

  return {
    text: finalText,
    stopReason: 'end_turn',
    usage,
  };
}
