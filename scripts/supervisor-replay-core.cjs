// Native-core transport for safe, evidence-fed supervisor replay. No VS Code keychain access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { loader } = require('./queue-scope-helpers.cjs');

function stateDatabase(env) {
  if (env.MFAGENT_REPLAY_STATE_DB) return env.MFAGENT_REPLAY_STATE_DB;
  const user = process.platform === 'win32' ? path.join(env.APPDATA || '', 'Code', 'User')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/Code/User')
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Code', 'User');
  return path.join(user, 'globalStorage', 'state.vscdb');
}

function resolveSupervisor(env = process.env) {
  const catalog = loader()('src/providers/catalog.ts');
  let own = {}, coding = {}, profiles = [];
  const stateFile = stateDatabase(env);
  if (!(env.MFAGENT_REPLAY_BASE_URL && env.MFAGENT_REPLAY_MODEL) && fs.existsSync(stateFile)) {
    const state = new DatabaseSync(stateFile, { readOnly: true });
    try {
      const row = state.prepare('SELECT value FROM ItemTable WHERE key = ?').get('mflores.mf-agent');
      const settings = row ? JSON.parse(row.value)['mfagent.settings.v2'] : undefined;
      own = settings?.roles?.supervisor || {};
      coding = settings?.roles?.coding || {};
      profiles = settings?.profiles || [];
    } finally { state.close(); }
  }
  const inherited = !own.profileId;
  const profile = profiles.find(p => p.id === (own.profileId || coding.profileId));
  const providerId = env.MFAGENT_REPLAY_PROVIDER || (env.MFAGENT_REPLAY_BASE_URL ? 'openai-compatible' : profile?.providerId);
  const provider = catalog.providerOrFallback(providerId || 'openai-compatible');
  const model = env.MFAGENT_REPLAY_MODEL || own.model || (inherited ? coding.model : '') || '';
  const baseURL = env.MFAGENT_REPLAY_BASE_URL || catalog.effectiveBaseURL(providerId, profile?.baseURL);
  const effort = env.MFAGENT_REPLAY_EFFORT ?? (own.effort || (inherited ? coding.effort : '') || '');
  const apiKey = env.MFAGENT_REPLAY_API_KEY || (provider.apiKeyEnv || []).map(name => env[name]).find(Boolean) || '';
  if (!model || !baseURL) throw Error('Configure the Supervisor role or set MFAGENT_REPLAY_BASE_URL and MFAGENT_REPLAY_MODEL.');
  if (!['openai-compatible', 'anthropic'].includes(provider.kind)) {
    throw Error('Replay requires an HTTP supervisor; editor/CLI transports need an explicit environment override.');
  }
  if (provider.apiKey === 'required' && !apiKey) {
    throw Error('The configured provider requires MFAGENT_REPLAY_API_KEY or its documented API-key environment variable; stored secrets are not extracted.');
  }
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Error('The replay endpoint must be an HTTP(S) base URL without embedded credentials or query parameters.');
  }
  return { model, baseURL, apiKey, effort, kind: provider.kind,
    source: env.MFAGENT_REPLAY_BASE_URL || env.MFAGENT_REPLAY_MODEL ? 'environment override' : 'VS Code Supervisor role' };
}

function corePath(env = process.env) {
  return path.resolve(env.MFAGENT_REPLAY_CORE || path.join(__dirname, '..', 'bin',
    `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'mfcore.exe' : 'mfcore'));
}

function sanitized(error, secret = '') {
  let message = String(error?.message || error);
  if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').split('\n')[0].slice(0, 700);
}

async function runCore(config, scratch, prompt, options = {}, timeoutMs = 600_000) {
  const binary = corePath();
  if (!fs.existsSync(binary)) throw Error('The native core is missing; build it or set MFAGENT_REPLAY_CORE.');
  const proc = spawn(binary, [], { cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1, aborted = false;
  const rejectAll = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const stop = () => {
    aborted = true;
    rejectAll(Error('Replay core stopped or request was cancelled.'));
    proc.stdin.end();
    proc.kill();
  };
  const lines = readline.createInterface({ input: proc.stdout });
  proc.stderr.on('data', () => {}); // Drain diagnostics without printing private prompts or credentials.
  proc.stdin.on('error', error => rejectAll(error));
  proc.on('error', error => rejectAll(error));
  proc.on('exit', code => rejectAll(Error(`Replay core exited (${code ?? 'signal'}).`)));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      // Never authorize requests back into the editor, even from an older core.
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Editor capabilities are unavailable in replay.' } }) + '\n');
    } else if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Error(sanitized(message.error.message, config.apiKey)));
      else entry.resolve(message.result);
    } else if (message.method) {
      if (message.method === 'stream/tool' && message.params?.status === 'running') {
        rejectAll(Error('The native core attempted tool execution despite response-only replay.'));
        stop(); return;
      }
      if (message.method === 'agent/activity') options.onActivity?.(message.params);
      options.onEvent?.(message.method, message.params);
    }
  });
  const request = (method, params, deadline) => new Promise((resolve, reject) => {
    if (aborted || proc.killed || proc.exitCode !== null) { reject(Error('Replay core is unavailable.')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} exceeded the replay deadline.`)); stop(); }, deadline);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
    options.onAbort?.(stop);
    await request('initialize', {
      workspaceRoot: scratch, inspectOnly: true, responseOnly: true, disableTools: true,
      memoryEnabled: false, memoryPath: path.join(scratch, 'memory.db'),
      maxIterations: 1, maxContextTokens: 200_000, llmIdleSeconds: 120,
      browserHeadless: true, editorTerminal: false, mcpServers: [], editorTools: [],
      providers: [{ id: 'replay-supervisor', type: config.kind, apiKey: config.apiKey,
        baseURL: config.baseURL, models: [config.model], enabled: true }],
      coding: { providerId: 'replay-supervisor', model: config.model, effort: config.effort },
    }, Math.min(timeoutMs, 30_000));
    return await request('chat/send', { sessionId: `supervisor-replay-${randomUUID()}`, text: prompt }, timeoutMs);
  } finally { stop(); lines.close(); }
}

module.exports = { resolveSupervisor, corePath, runCore, sanitized };
