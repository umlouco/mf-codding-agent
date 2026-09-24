import * as cp from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { resolveCoreBinary, resolveMcpBinary, workspaceRoot } from '../detect';
import { DiscoveredMcpServer } from '../mcp';
import { ResolvedRole } from '../providers/store';
import { killTree, Role, RunOptions, TurnResult } from './agents';
import { Usage } from './db';
import { getActiveQueue } from './registry';
import { loadTestingEnvironment, testingProcessEnvironment, testingPrompt, redactTestingSecrets } from './testingEnvironment';
import { getContext } from '../providers/instance';
import { cliInstructions, resolveCliMcpServers } from './cliCommon';

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

// Root cannot use Claude's bypass mode. Explicit approvals preserve unattended
// queue work in dontAsk mode while Claude still enforces deny rules and hooks.
// A bare "*" is not a supported allow rule; MCP approvals name our server below.
const ROOT_CLI_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'TodoWrite',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ToolSearch',
];

// Planner requests must not acquire implementation tools through CLI defaults,
// local permission settings, MCP servers, or delegation to another agent.
const PLANNER_CLI_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

// The tool-name prefixes that permit every tool of the passed MCP servers.
function mcpAllowedPatterns(names: readonly string[]): string[] {
  return names.map(name => `mcp__${name}__*`);
}

function cliMcpEntry(s: DiscoveredMcpServer): Record<string, unknown> {
  return s.url
    ? { type: 'http', url: s.url, headers: s.headers ?? {} }
    : { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} };
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
  const queue = getActiveQueue?.();
  const testing = queue ? await loadTestingEnvironment(getContext(), queue) : undefined;
  const isRoot = process.getuid?.() === 0 || process.geteuid?.() === 0;
  const plannerOnly = role === 'planner' || opts.planningOnly;
  const permissionMode = isRoot || opts.formatOnly || plannerOnly ? 'dontAsk' : 'bypassPermissions';

  // Every non-format-only turn gets the workspace's MCP servers, so a
  // CLI-backed planner, supervisor, executor or verifier reaches Jira,
  // Confluence and the other domain services through the same credentialed
  // path a native turn uses. A response-only turn has no tools, so it needs
  // none. `--strict-mcp-config` then makes this list the CLI's whole MCP world.
  const discovered = opts.formatOnly ? [] : await resolveCliMcpServers();
  const exposeTestingServer = !!(queue && testing && !opts.formatOnly && !plannerOnly);
  const mcpNames = [
    ...discovered.map(s => s.name),
    ...(exposeTestingServer ? ['mfagent'] : []),
  ];

  /*
   * The prompt goes in on stdin, never in argv.
   *
   * A planner prompt carries the whole queue — every task's title and full
   * description (see agents.ts's editTasks) — and a supervisor's carries a
   * task journal, so either runs to tens of thousands of characters on a real
   * project. Windows caps an entire command line at 32,767, and cp.spawn does
   * not degrade gracefully past it: it throws ENAMETOOLONG synchronously,
   * before the CLI is ever started. `claude -p` with no prompt argument reads
   * the prompt from stdin, which has no such limit.
   */
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', permissionMode,
    '--strict-mcp-config',
    '--append-system-prompt', cliInstructions(plannerOnly ? 'planner' : role, opts, mcpNames),
  ];
  if (plannerOnly && !opts.formatOnly) {
    args.push(
      '--tools', PLANNER_CLI_TOOLS.join(','),
      '--allowedTools', [...PLANNER_CLI_TOOLS, ...mcpAllowedPatterns(mcpNames)].join(','),
    );
  } else if (isRoot && !opts.formatOnly) {
    args.push('--allowedTools', [...ROOT_CLI_TOOLS, ...mcpAllowedPatterns(mcpNames)].join(','));
  }
  if (opts.formatOnly) {
    args.push("--tools", "");
    const index = args.indexOf('--append-system-prompt');
    args[index] = '--system-prompt';
    args[index + 1] = 'Review supplied text and evidence only. Return the exact requested decision schema. Do not investigate, call tools, or emit XML checks. Owner requirements outrank derived task instructions. Preserve required behavior and assertions.';
    if (opts.verificationOnly) {
      args[index + 1] = 'You are a skilled software tester verifying one assigned task. ' +
        'Check its deliverables and acceptance conditions without expanding into sibling work. ' +
        'For a document or inventory, inspect that deliverable; do not implement the tests it lists. ' +
        'Only supplied host receipts establish results. Distinguish failed invocations from application defects. ' +
        'Preserve owner requirements and the configured testing environment. Return the requested JSON schema. ' +
        'PASS requires every assigned condition to be supported; otherwise report FAIL or INCOMPLETE with the exact gap. ' +
        'Do not repeat an unchanged failed invocation. Tools are unavailable in this response turn.';
    }
    if (role === 'supervisor') {
      args[index + 1] = 'You are the engineering supervisor for an autonomous task queue, completing a response-only decision turn. ' +
        'Use supplied evidence; tools are unavailable. Return exactly the requested schema and action vocabulary. ' +
        'Preserve owner requirements, the assigned task scope, and independent verification requirements. ' +
        'Unfinished siblings are not defects in a committed child task. Distinguish observed application failures ' +
        'from failed invocations, missing evidence, and unsupported claims. Retain a supported diagnosis when ' +
        'repairing its format. Do not invent observations, a passing check, or an applied queue transition.';
    }
  }
  if (testing) prompt = testingPrompt(prompt, testing);
  if (queue && testing && !opts.formatOnly && !plannerOnly) {
    if (queue) {
      const core = resolveCoreBinary(getContext()).path;
      if (!core) throw new Error('The testing environment enforcement tool is unavailable.');
      const quote = (text: string) => "'" + text.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''") + "'";
      const hook = process.platform === 'win32'
        ? { type: 'command', shell: 'powershell', command: `& ${quote(core)} testing-hook; exit $LASTEXITCODE`, timeout: 10 }
        : { type: 'command', command: `${quote(core)} testing-hook`, timeout: 10 };
      args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [{ hooks: [hook] }] } }));
    }
    args[args.indexOf('--append-system-prompt') + 1] += '\n' + queue.testingContext + '\nRead testing_environment before testing. For Apache rewrites use apache_rewrite_check. Use environment variable references for credentials; never print their values.';
  }
  if (queue && testing && !opts.formatOnly && plannerOnly) {
    args[args.indexOf('--append-system-prompt') + 1] += '\n' + queue.testingContext +
      '\nUse the configured testing target and credential references in the plan. Executors perform installation, implementation and test runs; this planner can only inspect.';
  }
  // One --mcp-config covering the workspace's MCP servers plus, when testing is
  // configured, the bundled task-queue testing server. --strict-mcp-config
  // above makes this the CLI's complete MCP world, so the domain servers a
  // native turn reaches (Jira, Confluence, knowledge, code search) are present
  // here too rather than the CLI's own ambient configuration.
  if (mcpNames.length && !opts.formatOnly) {
    const mcpServers: Record<string, unknown> = {};
    for (const s of discovered) {
      mcpServers[s.name] = cliMcpEntry(s);
    }
    if (exposeTestingServer) {
      const mcpBin = resolveMcpBinary(getContext());
      if (!mcpBin) {
        throw new Error('The bundled task queue testing tools are unavailable. Rebuild or reinstall MF Agent.');
      }
      mcpServers.mfagent = { command: mcpBin, args: ['--workspace', cwd] };
    }
    args.push('--mcp-config', JSON.stringify({ mcpServers }));
  }
  if (resolved.model) {
    args.push('--model', resolved.model);
  }
  if (resolved.effort && VALID_CLI_EFFORTS.has(resolved.effort)) {
    args.push('--effort', resolved.effort);
  }
  const maxBudget = vscode.workspace
    .getConfiguration('mfagent')
    .get<number>('queue.claudeCli.maxBudgetUsd', 2);
  if (maxBudget > 0) {
    args.push('--max-budget-usd', String(maxBudget));
  }

  output.appendLine(`[queue:${role}] starting claude CLI (${resolved.model || 'default model'}, ${permissionMode})`);

  const proc = cp.spawn(bin, args, {
    cwd,
    env: { ...process.env, MFAGENT_QUEUE_ROLE: opts.verificationOnly ? 'validator' : opts.allowTestEdits ? 'supervisor-repair' : role, ...(testing ? testingProcessEnvironment(testing) : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Reported on 'close' below. Without a listener here, a failure to start at
  // all -- no `claude` on PATH being the usual one -- reaches the extension
  // host as an unhandled 'error' event instead of this turn's rejection.
  let spawnError: Error | undefined;
  proc.on('error', (err: Error) => {
    spawnError = err;
  });

  // An aborted or crashed CLI closes stdin from its end mid-write; that EPIPE
  // is the turn ending, not a fault to propagate.
  proc.stdin.on('error', () => {});
  proc.stdin.end(prompt);

  let cancelled = false;
  const cancel = () => { cancelled = true; killTree(proc.pid); };
  opts.onAbort?.(cancel);
  opts.onCancellable?.(cancel);

  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr += redactTestingSecrets(d.toString(), testing);
  });

  const toolNames = new Map<string, string>();
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  let finalResult: any;
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

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (cancelled) return;
    if (!line.trim()) {
      return;
    }
    let evt: any;
    try {
      evt = JSON.parse(line, (_key, value) => typeof value === "string" ? redactTestingSecrets(value, testing) : value);
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
          } else if (e.delta?.type === 'input_json_delta') {
            const block = toolBlocks.get(e.index);
            if (block) block.json += String(e.delta.partial_json ?? '');
          }
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          const id = String(e.content_block.id ?? '');
          const name = String(e.content_block.name ?? '');
          if (id) {
            toolNames.set(id, name);
            toolBlocks.set(e.index, { id, name, json: '' });
          }
          opts.onEvent?.('stream/tool', {
            id,
            name,
            status: 'running',
            input: e.content_block.input ?? {},
          });
          activity(name || 'using a tool');
        } else if (e?.type === 'content_block_stop') {
          const block = toolBlocks.get(e.index);
          toolBlocks.delete(e.index);
          if (block?.json) {
            try {
              opts.onEvent?.('stream/tool', { id: block.id, name: block.name,
                status: 'running', input: JSON.parse(block.json) });
            } catch { /* A complete assistant message may supply the input. */ }
          }
        }
        return;
      }
      case 'assistant': {
        for (const block of evt.message?.content ?? []) {
          if (block?.type !== 'tool_use' || !block.id) continue;
          toolNames.set(String(block.id), String(block.name ?? ''));
          opts.onEvent?.('stream/tool', { id: String(block.id), name: String(block.name ?? ''),
            status: 'running', input: block.input ?? {} });
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
            status: block.is_error ? 'error' : 'done',
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

  if (cancelled) throw new Error('Claude CLI turn cancelled; late output was discarded.');

  if (spawnError) {
    throw new Error(`could not start the claude CLI ("${bin}"): ${spawnError.message}`);
  }
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
