import * as cp from 'child_process';
import { CoreTransport, Output } from './coreTransport';
import { HeadlessRole, HeadlessTurn, HeadlessTurnOptions, TurnRunner } from './queueRunner';
import { LocalModelWaitConfig, localModelTiming, waitForLocalEndpoint } from './localModelWait';

export interface RoleEndpoint { model: string; baseURL?: string; apiKeyEnv?: string }
export interface HeadlessConfig extends LocalModelWaitConfig {
  workspaceRoot: string;
  coreBinary: string;
  claudeBinary: string;
  planner: RoleEndpoint;
  executor: RoleEndpoint;
  supervisor: RoleEndpoint;
  maxIterations?: number;
  maxContextTokens?: number;
  turnTimeoutMs?: number;
  plannerBudgetUsd?: number;
  mcpServers?: { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }[];
  instructions?: string;
}
export function roleInitialization(config: HeadlessConfig, role: 'executor' | 'supervisor', options: HeadlessTurnOptions = {}): object {
  const endpoint = config[role];
  if (!endpoint.baseURL || !endpoint.model) throw new Error(`Missing ${role} endpoint or model`);
  return {
    workspaceRoot: config.workspaceRoot, nativeFS: true, editorTerminal: false,
    queueRole: options.verificationOnly ? 'validator' : role,
    // Validators execute checks; queueRole enforces source/test ownership separately.
    // Inspection-only supervisors must not have arbitrary shell or browser mutations.
    inspectOnly: role === 'supervisor',
    providers: [{ id: role, type: 'openai-compatible', enabled: true,
      baseURL: endpoint.baseURL, models: [endpoint.model],
      apiKey: endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] ?? '' : '' }],
    coding: { providerId: role, model: endpoint.model },
    memoryEnabled: false, maxIterations: config.maxIterations ?? 40,
    maxContextTokens: config.maxContextTokens ?? 30000, llmIdleSeconds: localModelTiming(config).idleSeconds,
    browserHeadless: true, mcpServers: config.mcpServers ?? [],
  };
}

function claudeTurn(config: HeadlessConfig, prompt: string, output: Output, signal?: AbortSignal): Promise<HeadlessTurn> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', config.planner.model, '--output-format', 'json',
      '--no-session-persistence', '--strict-mcp-config', '--tools', 'Read,Glob,Grep',
      '--allowedTools', 'Read,Glob,Grep', '--system-prompt',
      'You are the read-only TDD planner. Inspect current source, preserve every supplied requirement, and return a concrete plan. Never edit files or execute shell commands.'];
    if ((config.plannerBudgetUsd ?? 2) > 0) args.push('--max-budget-usd', String(config.plannerBudgetUsd ?? 2));
    const proc = cp.spawn(config.claudeBinary, args, {
      cwd: config.workspaceRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const stop = () => {
      if (process.platform === 'win32' && proc.pid) {
        const killer = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => proc.kill());
      } else proc.kill();
    };
    const timeout = setTimeout(() => { stop(); reject(new Error('Planner turn timed out')); }, config.turnTimeoutMs ?? 600000);
    const abort = () => { stop(); reject(new Error('Planner cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    proc.stdin.on('error', () => {});
    proc.on('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); reject(error); });
    proc.on('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (code !== 0) { reject(new Error(`Planner exited ${code}: ${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.is_error || result.subtype !== 'success') throw new Error(result.result || `Planner ${result.subtype}`);
        output.appendLine(`[planner] model=${config.planner.model}; cost=${result.total_cost_usd ?? 'unknown'}`);
        resolve({ text: String(result.result ?? ''), stopReason: 'end_turn' });
      } catch (error) { reject(error); }
    });
    proc.stdin.end(prompt);
  });
}

/** Concrete production ports. Every role gets a fresh process and context. */
export function createRoleRunner(config: HeadlessConfig, output: Output, signal?: AbortSignal): TurnRunner {
  return async (role: HeadlessRole, prompt: string, options: HeadlessTurnOptions) => {
    if (signal?.aborted) throw new Error('Run cancelled');
    prompt = `${config.instructions ?? ''}\n${prompt}`;
    output.appendLine(`[${options.verificationOnly ? 'validator' : role}] starting ${config[role].model}`);
    if (role === 'planner') return claudeTurn(config, prompt, output, signal);
    const endpoint = config[role].baseURL;
    if (!endpoint) throw new Error(`Missing ${role} endpoint`);
    await waitForLocalEndpoint(endpoint, config, output, signal);
    const client = new CoreTransport({ binary: config.coreBinary, cwd: config.workspaceRoot, output,
      requestTimeoutMs: localModelTiming(config).requestTimeoutMs });
    const actor = options.verificationOnly ? 'validator' : role;
    const abort = () => client.stop();
    signal?.addEventListener('abort', abort, { once: true });
    client.onNotification((method, params) => {
      if (method === 'agent/activity') output.appendLine(`[${actor}] ${params.phase}: ${params.detail}`);
      if (method === 'stream/tool') output.appendLine(`[${actor}] tool ${JSON.stringify(params)}`);
    });
    try {
      const initialized = await client.request('initialize', roleInitialization(config, role, options));
      output.appendLine(`[${actor}] initialized ${initialized.model}; ${initialized.tools?.length ?? 0} tools`);
      for (const warning of initialized.warnings ?? []) output.appendLine(`[${actor}] warning: ${warning}`);
      if (signal?.aborted) throw new Error('Run cancelled');
      return await client.request<HeadlessTurn>('chat/send', { sessionId: `${role}-${Date.now()}`, text: prompt });
    } finally { signal?.removeEventListener('abort', abort); client.dispose(); }
  };
}
