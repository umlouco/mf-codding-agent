import * as cp from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { workspaceRoot } from '../detect';
import { ResolvedRole } from '../providers/store';
import { killTree, Role, RunOptions, TurnResult } from './agents';
import { Usage } from './db';

/**
 * Runs one turn through the `claude` CLI as a subprocess, instead of mfcore.
 *
 * Claude Code is a complete agent on its own — its own tool loop, its own
 * permission handling, its own MCP client — so this does not try to plug it
 * into mfcore's agent loop the way an HTTP provider is. It is spawned
 * directly, one `-p` turn per call, and its `stream-json` events are
 * translated into the same `stream/text` / `stream/thinking` / `stream/tool`
 * notification shapes the rest of the queue already knows how to read off
 * `RunOptions.onEvent` — see `agents.ts`'s `runOnce`, the only caller.
 *
 * Event shapes below were captured from a real run (`claude -p ... --output-
 * format stream-json --include-partial-messages --verbose`), not just docs:
 * text/thinking deltas live at `event.delta.text` / `event.delta.thinking`
 * inside `{type:"stream_event", event:{type:"content_block_delta", ...}}`; a
 * tool call starts at `{type:"stream_event", event:{type:"content_block_
 * start", content_block:{type:"tool_use", id, name, input}}}`; its result
 * comes back as a *separate*, non-stream_event, top-level `{type:"user",
 * message:{content:[{type:"tool_result", tool_use_id, content}]}}` line —
 * not nested under the tool_use event the way one might expect.
 */

/** How the CLI's own `--effort` flag is spelled; this app's own vocabulary
 * additionally allows 'minimal', which the CLI does not accept. */
const VALID_CLI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function systemSuffixFor(role: Role): string {
  if (role === 'supervisor') {
    return (
      'You are the Supervisor of an autonomous task queue. You have no tools available: judge ' +
      'only the text you are given in this prompt, exactly as it instructs.'
    );
  }
  return (
    'You are the Planner for an autonomous task queue running inside this workspace. Read the ' +
    'workspace to inform your answer; do not edit or run anything.'
  );
}

/**
 * Settings' "Test" button for a Claude CLI profile: there is no endpoint to
 * ping (`listStyle: 'none'`), so this checks the one thing that actually
 * varies machine-to-machine — whether the binary resolves at all — by
 * running `<bin> --version`.
 */
export function testClaudeCliBinary(cliPath?: string): Promise<{ ok: boolean; message: string }> {
  const bin = cliPath?.trim() || 'claude';
  return new Promise((resolve) => {
    const proc = cp.spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('error', (err) => resolve({ ok: false, message: `Could not run "${bin}": ${err.message}` }));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, message: `Found ${out.trim() || bin}.` });
      } else {
        resolve({ ok: false, message: `"${bin} --version" exited with code ${code}.` });
      }
    });
  });
}

export async function runClaudeCliTurn(
  output: vscode.OutputChannel,
  role: Role,
  resolved: ResolvedRole,
  prompt: string,
  opts: RunOptions,
): Promise<TurnResult> {
  const bin = resolved.profile?.extra?.cliPath?.trim() || 'claude';
  const cwd = workspaceRoot() || process.cwd();

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config',
    '--append-system-prompt', systemSuffixFor(role),
  ];
  if (resolved.model) {
    args.push('--model', resolved.model);
  }
  if (resolved.effort && VALID_CLI_EFFORTS.has(resolved.effort)) {
    args.push('--effort', resolved.effort);
  }
  if (role === 'supervisor') {
    // Parity with mfcore's own disableTools:true override for the same role
    // (see agents.ts's overridesFor) — the supervisor judges what other
    // agents already wrote to the database, not the live workspace.
    args.push('--tools', '');
  }
  const maxBudget = vscode.workspace
    .getConfiguration('mfagent')
    .get<number>('queue.claudeCli.maxBudgetUsd', 2);
  if (maxBudget > 0) {
    args.push('--max-budget-usd', String(maxBudget));
  }

  output.appendLine(`[queue:${role}] starting claude CLI (${resolved.model || 'default model'})`);

  const proc = cp.spawn(bin, args, {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  opts.onAbort?.(() => killTree(proc.pid));
  opts.onCancellable?.(() => killTree(proc.pid));

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });

  const toolNames = new Map<string, string>();
  let finalResult: any;
  let lastActivityAt = 0;

  const activity = (detail: string) => {
    const now = Date.now();
    if (!opts.onActivity || now - lastActivityAt < 3000) {
      return;
    }
    lastActivityAt = now;
    opts.onActivity({ phase: role, detail, at: now });
  };

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    handleLine(evt);
  });

  function handleLine(evt: any): void {
    switch (evt.type) {
      case 'result':
        finalResult = evt;
        return;
      case 'stream_event': {
        const e = evt.event;
        if (e?.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta') {
            opts.onEvent?.('stream/text', { delta: e.delta.text });
            activity('writing');
          } else if (e.delta?.type === 'thinking_delta') {
            opts.onEvent?.('stream/thinking', { delta: e.delta.thinking });
            activity('thinking');
          }
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          const id = String(e.content_block.id ?? '');
          const name = String(e.content_block.name ?? '');
          if (id) {
            toolNames.set(id, name);
          }
          opts.onEvent?.('stream/tool', {
            id,
            name,
            status: 'running',
            input: e.content_block.input ?? {},
          });
          activity(name || 'using a tool');
        }
        return;
      }
      case 'user': {
        // Tool results arrive as a top-level "user" message, not nested in
        // the stream_event the tool_use came from — see the module doc.
        const content = evt.message?.content;
        if (!Array.isArray(content)) {
          return;
        }
        for (const block of content) {
          if (block?.type !== 'tool_result') {
            continue;
          }
          const id = String(block.tool_use_id ?? '');
          opts.onEvent?.('stream/tool', {
            id,
            name: toolNames.get(id) ?? '',
            status: 'done',
            output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  const started = Date.now();
  const exitCode: number = await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code ?? -1));
  });
  rl.close();

  if (!finalResult) {
    throw new Error(
      `claude CLI exited (code ${exitCode}) with no result` +
        (stderr.trim() ? `: ${stderr.trim().slice(0, 2000)}` : ''),
    );
  }
  if (finalResult.is_error) {
    throw new Error(String(finalResult.result || `claude CLI reported an error (code ${exitCode})`));
  }

  const u = finalResult.usage ?? {};
  const usage: Usage = {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  };
  const cost = Number(finalResult.total_cost_usd) || 0;
  output.appendLine(
    `[queue:${role}] claude CLI turn finished in ${Math.round((Date.now() - started) / 1000)}s ` +
      `($${cost.toFixed(4)}, ${usage.input} in / ${usage.output} out)`,
  );

  return {
    text: String(finalResult.result ?? ''),
    stopReason: String(finalResult.stop_reason || (exitCode === 0 ? 'end_turn' : 'error')),
    usage,
  };
}
