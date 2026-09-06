// Run with: node --test scripts/cognition-queue.test.cjs
// Exercise the real process request boundary and queue consumers with model/RPC doubles.
const { readFileSync } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}, extra = '') {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, Buffer, setTimeout, clearTimeout,
    require: name => dependencies[name] ?? (name === 'crypto' ? crypto : {}),
  }, { filename: file });
  return exports;
}

const cognition = load('src/queue/cognition.ts');
const prompts = load('src/queue/prompts.ts');
const validation = load('src/queue/validation.ts');
const vscode = { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const output = { appendLine() {} };
const task = {
  id: 42, seq: 1, createdAt: 1000, attempts: 1, maxAttempts: 3, title: 'Preserve records',
  description: 'Save records across a restart.', kind: 'task', region: '',
  implVerifyPrompt: 'Inspect the persistence contract', solutionVerifyPrompt: 'Exercise a restart',
  solutionVerifyCommand: '', errorLog: '', supervisorFeedback: '', output: '', validationReport: '',
  status: 'EXECUTING', activityPhase: '', activityDetail: '',
};
const goal = 'Keep the engineer continuous across disposable model sessions.';

function agentModule(extraDependencies = {}) {
  return load('src/queue/agents.ts', {
    vscode, './cognition': cognition, './prompts': prompts, './validation': validation,
    ...extraDependencies,
  }, '\nexport function setTestRunner(runner: typeof runOnce) { runOnce = runner; }');
}

test('durable identity follows work through rewrites, fresh attempts, and different observers', () => {
  const first = cognition.taskCognition(task, goal, 'executor');
  const retry = cognition.taskCognition({ ...task, description: 'A new approach', attempts: 0 }, goal, 'executor');
  assert.equal(first.workId, retry.workId);
  const verifier = cognition.taskCognition(task, goal, 'verifier');
  assert.equal(first.workId, verifier.workId);
  assert.notEqual(first.observer, verifier.observer);
  for (const replacement of [{ ...task, id: 43 }, { ...task, createdAt: 2000 }]) {
    assert.notEqual(cognition.taskCognition(replacement, goal, 'executor').workId, first.workId);
  }
  assert.notEqual(cognition.taskCognition(task, goal + ' A different request.', 'executor').workId, first.workId);
});

test('real runOnce forwards cognitive binding across fresh core processes and relays observations', async () => {
  const clients = [];
  const requests = [];
  const notifications = [];
  const binding = cognition.taskCognition(task, goal, 'executor');
  class CoreClient {
    constructor() { clients.push(this); }
    onNotification(listener) { this.listener = listener; }
    async start() {}
    async initialize() { return { model: 'test-model', provider: 'test-provider', memory: false }; }
    async request(method, params) {
      requests.push({ method, params });
      this.listener('agent/cognition', snapshot(binding));
      return { text: 'Observed', stopReason: 'end_turn', usage };
    }
    dispose() { this.disposed = true; }
  }
  const agents = agentModule({
    '../core': { CoreClient }, '../editorFs': { registerEditorFsHandlers() {} },
    '../mcpBridge': { getBridge: () => ({ attach() {} }) },
    '../providers/instance': { getStore: () => ({ resolve: async () => ({ kind: 'http', model: 'test-model' }) }) },
    '../providers/payload': { contextCeiling: () => 128000 },
    '../llm/router': { getRouter: () => ({ endpointFor: async () => ({ type: 'openai-compatible' }) }) },
  });
  for (let i = 0; i < 2; i++) {
    await agents.runOnce({}, output, 'executor', 'Continue the same task.', {
      cognition: binding,
      onEvent: (method, params) => notifications.push({ method, params }),
    });
  }
  assert.equal(clients.length, 2);
  assert.ok(clients.every(client => client.disposed));
  assert.ok(requests.every(request => request.method === 'chat/send' && request.params.cognition === binding));
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].method, 'agent/cognition');
  assert.equal(notifications[0].params.workId, binding.workId);
});

test('unavailable runtime memory is visible at worker startup without blocking the worker request', async () => {
  const lines = [];
  const activity = [];
  let turnsSent = 0;
  const warning = 'runtime memory unavailable: database cannot be opened';
  class CoreClient {
    onNotification() {}
    async start() {}
    async initialize() {
      return { model: 'test-model', provider: 'test-provider', cognition: false,
        warnings: [warning, warning, 'Graph memory is using keyword-only search.'] };
    }
    async request(method) {
      assert.equal(method, 'chat/send');
      turnsSent++;
      return { text: 'The requested tool executed.', stopReason: 'end_turn', usage };
    }
    dispose() {}
  }
  const agents = agentModule({
    '../core': { CoreClient }, '../editorFs': { registerEditorFsHandlers() {} },
    '../mcpBridge': { getBridge: () => ({ attach() {} }) },
    '../providers/instance': { getStore: () => ({ resolve: async () => ({ kind: 'http', model: 'test-model' }) }) },
    '../providers/payload': { contextCeiling: () => 128000 },
    '../llm/router': { getRouter: () => ({ endpointFor: async () => ({ type: 'openai-compatible' }) }) },
  });
  const result = await agents.runOnce({}, { appendLine: line => lines.push(line) }, 'executor', 'Run the tool.', {
    cognition: cognition.taskCognition(task, goal, 'executor'),
    onActivity: event => activity.push(event),
  });
  assert.equal(turnsSent, 1);
  assert.equal(result.text, 'The requested tool executed.');
  assert.equal(activity.length, 1, 'startup failure is reported once to the worker owner');
  assert.equal(activity[0].phase, 'error');
  assert.equal(activity[0].detail, warning);
  assert.equal(lines.filter(line => line.includes(warning)).length, 1);
  assert.ok(lines.some(line => line.includes('keyword-only search')));
});

test('executor, independent verifier, and phase expansion use durable bindings with separate observers', async () => {
  const agents = agentModule();
  const calls = [];
  let reply = '{}';
  const runner = async (_, __, role, prompt, opts) => {
    calls.push({ role, opts });
    return { text: reply, stopReason: 'end_turn', usage };
  };
  agents.setTestRunner(runner);
  await agents.executeTask({}, output, task, '', goal);
  const verifier = load('src/queue/verification.ts', {
    './agents': { ...agents, runOnce: runner }, './cognition': cognition,
    './prompts': prompts, './validation': validation,
  });
  await verifier.runVerification({}, output, task, goal);
  reply = JSON.stringify([{ title: 'Exercise persistence', description: 'Verify continuity after restart',
    implVerifyPrompt: 'Read state', solutionVerifyPrompt: 'Restart', solutionVerifyCommand: '' }]);
  await agents.expandPhase({}, output, { ...task, kind: 'phase' }, goal);
  assert.deepEqual(calls.map(call => call.role), ['executor', 'executor', 'planner']);
  assert.deepEqual(calls.map(call => call.opts.cognition.observer), ['executor', 'verifier', 'planner']);
  assert.equal(new Set(calls.map(call => call.opts.cognition.workId)).size, 1);
});

test('all supervisor recovery and response format paths retain the same binding', async () => {
  const agents = agentModule();
  const calls = [];
  let replies = [];
  const runner = async (_, __, role, prompt, opts) => {
    calls.push({ role, binding: opts.cognition });
    const reply = replies.shift();
    assert.notEqual(reply, undefined, 'unexpected extra model call');
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), stopReason: 'end_turn', usage };
  };
  agents.setTestRunner(runner);
  const rewrite = { description: 'Inspect the persisted observations, then correct the missing storage path.',
    feedback: 'Recover the storage boundary', taskEdits: [] };
  // Bare retry requires a concrete rewrite; an exhausted attempt uses escalation.
  for (const attempts of [1, 3]) {
    replies = [{ verdict: 'RETRY', feedback: 'State disappeared' }, rewrite];
    await agents.superviseTask({}, output, { ...task, attempts }, 0, goal);
    assert.equal(replies.length, 0);
  }
  replies = ['The task needs recovery.', { verdict: 'RETRY', feedback: 'State disappeared',
    taskEdits: [{ seq: task.seq, description: rewrite.description }] }];
  await agents.superviseTask({}, output, task, 0, goal);
  const monitor = load('src/queue/monitor.ts', {
    './agents': { ...agents, runOnce: runner }, './cognition': cognition,
    './prompts': prompts, './validation': validation,
  });
  replies = ['Continue the useful work.', { action: 'CONTINUE_EXECUTION', reason: 'New observations' }];
  await monitor.reviewProgress({}, output, task, [], 0, {}, goal);
  assert.equal(calls.length, 8);
  const expected = cognition.taskCognition(task, goal, 'supervisor');
  for (const call of calls) {
    assert.equal(call.role, 'supervisor');
    assert.equal(call.binding.workId, expected.workId);
    assert.equal(call.binding.observer, expected.observer);
  }
});

function snapshot(binding = cognition.taskCognition(task, goal, 'executor')) {
  return { ...binding, version: 1, seq: 7, epoch: 2, omitted: 0,
    summary: 'A changed file has not been read again. This does not establish completion.',
    focus: [{ rule: 'reobserve', priority: 80, evidence: [3, 7], detail: 'Read the current contents.' }] };
}

test('runtime observations reach durable journal and live output without renewing worker liveness', () => {
  const { LiveLog } = load('src/queue/liveLog.ts', { vscode, './cognition': cognition });
  const { Orchestrator } = load('src/queue/orchestrator.ts', {
    './cognition': cognition, './liveLog': { LiveLog },
  });
  const persisted = [];
  const live = [];
  const queue = {
    log: (...args) => persisted.push(args),
    appendLog: (...args) => live.push(args),
    recordActivity() { throw new Error('Observations must not refresh a worker heartbeat'); },
  };
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.queue = queue;
  for (const actor of ['executor', 'validator']) {
    const journal = orchestrator.streamJournal(task.id, actor);
    journal.onEvent('agent/cognition', snapshot());
    journal.onEvent('agent/cognition', snapshot());
    journal.flush();
  }
  const supervisorLive = new LiveLog(queue, task.id, 'supervisor');
  const superviseEvents = orchestrator.observerEvents(task.id, 'supervisor', supervisorLive);
  superviseEvents('agent/cognition', snapshot());
  superviseEvents('agent/cognition', snapshot());
  assert.equal(persisted.length, 3);
  assert.equal(live.length, 3);
  assert.deepEqual(persisted.map(row => row[1]), ['executor', 'validator', 'supervisor']);
  for (const row of persisted) {
    assert.equal(row[2], 'cognition');
    const record = JSON.parse(row[3]);
    assert.equal(record.seq, 7);
    assert.deepEqual(record.focus[0].evidence, [3, 7]);
    assert.match(record.summary, /does not establish completion/);
  }
});

test('observation records reject malformed snapshots and stay valid JSON inside journal bounds', () => {
  assert.equal(cognition.cognitionRecord({ summary: 'The model says complete' }), undefined);
  const large = snapshot();
  large.summary = 'x'.repeat(10000);
  large.focus = Array.from({ length: 100 }, () => ({ rule: 'r'.repeat(500), priority: 10,
    evidence: Array.from({ length: 100 }, (_, i) => i), detail: 'd'.repeat(10000) }));
  const record = cognition.cognitionRecord(large);
  assert.ok(record.length < 8000);
  const parsed = JSON.parse(record);
  assert.equal(parsed.omitted, 94);
  assert.equal(parsed.focus.length, 6);
  assert.equal(parsed.focus[0].evidence.length, 12);
});

test('snapshot normalization preserves unbound chat and direct-tool observer identities', () => {
  for (const observer of ['coder', 'user']) {
    const record = cognition.cognitionRecord({ ...snapshot(), observer });
    assert.equal(JSON.parse(record).observer, observer);
  }
  assert.equal(cognition.cognitionRecord({ ...snapshot(), observer: 'unrecognized' }), undefined);
});

test('interactive conversation identity survives a panel reload and changes for a new conversation', async () => {
  const state = new Map();
  const workspaceState = {
    get: key => state.get(key),
    update: async (key, value) => { state.set(key, value); },
  };
  const sent = [];
  const core = {
    onNotification: () => ({ dispose() {} }),
    request: async (method, params) => { sent.push({ method, params }); },
  };
  const mockVscode = {
    workspace: { textDocuments: [], workspaceFolders: [], asRelativePath: value => value },
    window: {}, ViewColumn: { Active: 1 }, Uri: { joinPath: () => ({}) },
  };
  const { ChatPanel } = load('src/panel.ts', { vscode: mockVscode });
  ChatPanel.prototype.html = () => '';
  const panel = () => ({
    webview: { onDidReceiveMessage() {}, postMessage() {}, options: {} },
    onDidDispose() {}, reveal() {},
  });
  const context = { workspaceState, extensionUri: {} };
  const first = new ChatPanel(panel(), context, core, output);
  await first.sendPrompt('Investigate this project.');
  const reloaded = new ChatPanel(panel(), context, core, output);
  await reloaded.sendPrompt('Continue the investigation.');
  assert.equal(sent[0].params.cognition.workId, sent[1].params.cognition.workId);
  assert.equal(sent[0].params.sessionId, state.get('mfagent.chatSessionId'));
  assert.match(sent[0].params.sessionId, /^chat:[0-9a-f-]{36}$/);
  assert.equal(sent[0].params.cognition.observer, 'executor');
  await reloaded.newSession();
  await reloaded.sendPrompt('A separate request.');
  assert.equal(sent[2].method, 'chat/reset');
  assert.equal(sent[2].params.sessionId, sent[0].params.sessionId);
  assert.notEqual(sent[3].params.cognition.workId, sent[0].params.cognition.workId);
  assert.equal(sent[3].params.sessionId, state.get('mfagent.chatSessionId'));
});
