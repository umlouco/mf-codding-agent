#!/usr/bin/env node
// Opt-in REAL provider + core verification against an isolated source/queue copy.
// No keychain extraction. --allow-endpoint must exactly name the configured custom provider.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { loader } = require('./queue-scope-helpers.cjs');
const { sourceReceipt } = require('./supervisor-replay.cjs');
const { resolveSupervisor, runCore, sanitized } = require('./supervisor-replay-core.cjs');

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

function copyWorkspace(source, target) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  const excluded = /(^|\/)(?:\.git|\.mfagent|node_modules|\.venv|\.chroma|\.opencode|\.vscode|bin|build)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:exe|db|dll)$/i;
  const hashes = {};
  for (const relative of [...new Set(paths)]) {
    const from = path.resolve(source, relative), to = path.resolve(target, relative);
    if (!inside(source, from) || !inside(target, to) || excluded.test(relative) || !fs.existsSync(from)) continue;
    const info = fs.lstatSync(from);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    hashes[relative] = hash(fs.readFileSync(from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return hashes;
}

// Only the transport/editor boundary is adapted. VerificationSession, parser,
// invocation ordering, receipt checks, prompts, and report gates are production code.
function toolClient(binary, scratch, original) {
  return class ReplayCoreClient {
    constructor() { this.pending = new Map(); this.next = 1; this.stopped = false; }
    async start() {
      this.proc = spawn(binary, [], { cwd: scratch, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.lines = readline.createInterface({ input: this.proc.stdout });
      this.proc.stderr.on('data', () => {});
      this.proc.stdin.on('error', error => this.rejectAll(error));
      this.proc.on('error', error => this.rejectAll(error));
      this.proc.on('exit', code => this.rejectAll(Error(`Replay tool core exited: ${code}`)));
      this.lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.method && message.id !== undefined) {
          this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
            error: { code: -32601, message: 'Replay cannot mutate editor documents or invoke editor tools.' } }) + '\n');
          return;
        }
        if (message.id === undefined) return;
        const wait = this.pending.get(message.id);
        if (!wait) return;
        this.pending.delete(message.id); clearTimeout(wait.timer);
        message.error ? wait.reject(Error(message.error.message)) : wait.resolve(message.result);
      });
      await new Promise((resolve, reject) => { this.proc.once('spawn', resolve); this.proc.once('error', reject); });
    }
    initialize(overrides) {
      return this.request('initialize', { ...overrides, workspaceRoot: scratch,
        responseOnly: true, memoryEnabled: false, memoryPath: path.join(scratch, '.mfagent', 'memory.db'),
        browserHeadless: true, editorTerminal: false, mcpServers: [], editorTools: [],
        providers: [], coding: {}, vision: {}, embedding: {} });
    }
    request(method, params = {}) {
      if (method === 'tools/invoke') {
        // Source task text can contain absolute source paths. A replay must not
        // follow those back out of the isolated copy, even if a model requests it.
        const args = JSON.stringify(params.input || {}).toLowerCase().replace(/\\\\/g, '/').replace(/\\/g, '/');
        if (args.includes(original.toLowerCase().replace(/\\/g, '/'))) {
          return Promise.resolve({ output: 'Replay refused an invocation targeting the original workspace.', isError: true });
        }
      }
      return new Promise((resolve, reject) => {
        if (this.stopped) return reject(Error('Replay tool core is stopped'));
        const id = this.next++;
        const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} exceeded replay deadline`)); this.dispose(); }, 180000);
        this.pending.set(id, { resolve, reject, timer });
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
    rejectAll(error) {
      for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
      this.pending.clear();
    }
    dispose() {
      if (this.stopped) return;
      this.stopped = true;
      this.rejectAll(Error('Replay stopped'));
      // Closing stdin lets the real core drain RPC and close browser/cognition.
      this.proc?.stdin.end();
      const timer = setTimeout(() => this.proc?.kill(), 3000);
      timer.unref();
      this.proc?.once('exit', () => { clearTimeout(timer); this.lines?.close(); });
    }
  };
}

async function replay(options) {
  const config = resolveSupervisor();
  if (config.kind !== 'openai-compatible' || config.baseURL !== options['allow-endpoint']) {
    throw Error('Replay requires explicit authorization of the exact configured custom endpoint.');
  }
  const original = fs.realpathSync(options.workspace), scratch = path.resolve(options.scratch);
  const binary = fs.realpathSync(options.core);
  if (inside(original, scratch) || fs.existsSync(scratch)) throw Error('Scratch must be a NEW directory outside the original workspace.');
  fs.mkdirSync(scratch, { recursive: true });
  const sourceFile = path.join(original, '.mfagent', 'queue.db');
  const before = sourceReceipt(sourceFile);
  const copiedFiles = copyWorkspace(original, scratch);
  fs.mkdirSync(path.join(scratch, '.mfagent'), { recursive: true });
  const queueFile = path.join(scratch, '.mfagent', 'queue.db');
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let sourceRunState;
  try {
    sourceRunState = source.prepare("SELECT value FROM queue_meta WHERE key = 'runState'").get()?.value;
    await backup(source, queueFile);
  } finally { source.close(); }
  const calls = [], events = [], clients = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  process.env.MFAGENT_REPLAY_CORE = binary;
  const Client = toolClient(binary, scratch, original);
  let queue;
  const runtime = {
    workerRounds: () => 80, supervisorRounds: () => 40,
    runOnce: async (_context, _output, role, prompt, opts = {}) => {
      if (!['executor', 'supervisor'].includes(role) || (role === 'executor' && !opts.formatOnly)) {
        throw Error('Replay stops before implementation; only verification and supervisor decisions are permitted.');
      }
      const entry = { number: calls.length + 1, role, promptHash: hash(prompt), start: Date.now() };
      calls.push(entry);
      process.stderr.write(`Local verification replay: ${role} model request ${entry.number}.\n`);
      const result = await runCore(config, scratch, prompt, opts, 600000);
      entry.elapsedMs = Date.now() - entry.start; entry.stopReason = result.stopReason;
      entry.response = result.text; entry.usage = result.usage;
      for (const key of Object.keys(usage)) usage[key] += result.usage?.[key] || 0;
      return { ...result, usage: result.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const load = loader({
    '../core': { CoreClient: class extends Client { constructor(...args) { super(...args); clients.push(this); } } },
    '../editorFs': { registerEditorFsHandlers() {} },
    '../mcpBridge': { getBridge: () => ({ attach() {} }) },
    './registry': { getActiveQueue: () => queue },
    './testingEnvironment': { loadTestingEnvironment: async () => ({ url: '', credentials: {} }), redactTestingSecrets: value => value },
    './agentRuntime': runtime,
    './agents': new Proxy({}, { get: (_target, key) => {
      if (key in runtime) return runtime[key];
      const files = { extractJson: 'agentJson', attemptsExhausted: 'agentReviewSupport',
        coreHalted: 'agentExecution', executeTask: 'agentExecution', superviseTask: 'agentSupervisor' };
      return files[key] ? load(`src/queue/${files[key]}.ts`)[key] : undefined;
    } }),
  });
  queue = load('src/queue/db.ts').TaskQueue.open(queueFile);
  const task = queue.list().find(task => task.seq === Number(options.seq));
  if (!task) throw Error('Requested sequence not found in queue backup.');
  const acceptance = task => task && Object.fromEntries(['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand', 'region'].map(key => [key, task[key]]));
  const contractBefore = hash(acceptance(task));
  let result, failure, scheduler;
  try {
    if (options.mode === 'scheduler') {
      scheduler = await require('./verification-replay-scheduler.cjs').drive(load, queue, task, options);
      const finalTask = queue.get(task.id);
      const latestReport = scheduler.verificationReports.at(-1)?.serialized ||
        (finalTask?.validationReport !== task.validationReport ? finalTask?.validationReport : undefined);
      if (latestReport) {
        result = { text: '', validationReport: latestReport, stopReason: 'bounded-scheduler-replay', usage };
      }
    } else {
    const boundedTask = load('src/queue/scopeBoundary.ts').boundedTask;
    result = await load('src/queue/verification.ts').runVerification({}, { appendLine() {} }, boundedTask(task),
      queue.getMeta('goal'), undefined, (method, params) => {
        if (['verification/plan', 'verification/receipts', 'stream/tool'].includes(method)) {
          events.push({ method, params });
          if (method !== 'stream/tool' || params.status !== 'running') process.stderr.write(`Replay event ${method}${params.name ? ': ' + params.name + ' ' + params.status : ''}\n`);
        }
      }, undefined, queue.contextInstructions, load('src/queue/verificationAuthority.ts').verificationAuthority(queue, task));
    }
  } catch (error) { failure = sanitized(error, config.apiKey); }
  finally { for (const client of clients) client.dispose(); }
  const copiedAcceptanceUnchanged = contractBefore === hash(acceptance(queue.get(task.id)));
  queue.close();
  const after = sourceReceipt(sourceFile);
  const originalFilesUnchanged = Object.entries(copiedFiles).every(([relative, before]) => hash(fs.readFileSync(path.join(original, relative))) === before);
  const report = { version: 1, mode: 'real local-provider production runVerification against isolated workspace and SQLite copy',
    sourceTaskId: task.id, seq: task.seq, original, scratch, model: config.model, coreHash: hash(fs.readFileSync(binary)),
    copiedFileCount: Object.keys(copiedFiles).length, copiedAcceptanceUnchanged, sourceDatabaseUnchanged: hash(before) === hash(after),
    sourceRunStateAtBackup: sourceRunState, sourceDatabaseBefore: before, sourceDatabaseAfter: after,
    originalFilesUnchanged, calls, usage, events, error: failure, outcome: result, scheduler,
    limitations: ['Source copy excludes ignored dependencies, binaries, environment/secret files, and editor settings.',
      'Editor/MCP integrations and vision inference are not connected in this isolated replay.',
      'Browser URLs in the unchanged task may observe an already-running application; that server process is not copied.',
      'A concurrently running original queue can change its database during replay; source hashes detect change, not its attribution.',
      'Observed missing copied dependencies must remain INCOMPLETE, never be relabeled success.',
      options.mode === 'scheduler' ? 'Actual scheduler with 10-second timer on the copy; no implementation worker or actual VS Code UI.'
        : 'This exercises verification, not the production queue scheduler or actual VS Code UI.'] };
  const reportFile = path.join(scratch, 'verification-replay-report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile, error: failure, model: config.model, calls: calls.length, usage,
    conclusion: result ? JSON.parse(result.validationReport).conclusion : null,
    copiedAcceptanceUnchanged, sourceDatabaseUnchanged: report.sourceDatabaseUnchanged, originalFilesUnchanged }, null, 2));
  if (failure || !copiedAcceptanceUnchanged || !report.sourceDatabaseUnchanged || !originalFilesUnchanged) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (i % 2 === 0) pairs.push([value.replace(/^--/, ''), all[i + 1]]);
    return pairs;
  }, []));
  if (!['workspace', 'scratch', 'seq', 'core', 'allow-endpoint'].every(key => options[key])) {
    process.stderr.write('Usage: verification-replay.cjs --workspace <repo> --seq <number> --scratch <new-directory> --core <binary> --allow-endpoint <configured-custom-url>\n');
    process.exitCode = 1;
  } else replay(options).catch(error => { process.stderr.write(sanitized(error) + '\n'); process.exitCode = 1; });
}

module.exports = { replay, copyWorkspace, toolClient };
