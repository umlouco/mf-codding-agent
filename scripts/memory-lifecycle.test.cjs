const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, mocks = {}, globals = {}, expose = '') {
  const absolute = path.resolve(__dirname, '..', file);
  const localRequire = createRequire(absolute);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8') + expose, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports,
    require: name => mocks[name] ?? localRequire(name), process, Buffer, console,
    setTimeout, clearTimeout, setInterval, clearInterval, ...globals }, { filename: absolute });
  return module.exports;
}

class Element {
  children = [];
  parentElement = null;
  className = '';
  text = '';
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  appendChild(child) { child.parentElement = this; this.children.push(child); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this);
    this.parentElement = null;
  }
  set textContent(text) {
    this.text = text;
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
  querySelector(selector) { return this.children.find(x => x.className === selector.slice(1)); }
}

function terminalUI() {
  const window = {};
  let created = 0;
  const document = { createElement() { created++; return new Element(); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/queue-terminal.js'), 'utf8'), { window, document });
  const sent = [];
  const ui = window.MFQueueUI.terminal({ send: msg => sent.push(msg) });
  const row = (chunk, taskId = 1, kind = 'response') => ({ chunk, taskId, kind, actor: 'executor' });
  return { ui, sent, row, created: () => created };
}

test('live terminals bound a continuous stream and oversized single chunks', () => {
  const { ui, row } = terminalUI();
  const pre = new Element();
  ui.mountTerm('1', pre);
  for (let i = 0; i < 2000; i++) ui.onLogs({ rows: [row('x'.repeat(1024))] });
  assert.equal(pre.children.length, 1);
  assert.equal(pre.children[0].querySelector('.tb-t').textContent.length, 120_000);
  ui.onLogs({ rows: [row('y'.repeat(2_000_000))] });
  assert.equal(pre.children[0].querySelector('.tb-t').textContent, 'y'.repeat(120_000));
  for (let i = 0; i < 1000; i++) ui.onLogs({ rows: [row('tool', 1, 'tool')] });
  assert.ok(pre.children.length <= 400);
});

test('closed/deleted terminals and old task DOM are released; reopening reloads the tail', () => {
  const { ui, sent, row, created } = terminalUI();
  const pre = new Element();
  ui.mountTerm('1', pre);
  ui.onLogs({ rows: [row('before')] });
  ui.prepareTasks(['1']);
  ui.onLogs({ rows: [row(' after')] });
  assert.ok(!pre.textContent.includes('after'), 'detached DOM must not receive stream updates');
  const replacement = new Element();
  ui.mountTerm('1', replacement);
  assert.ok(replacement.textContent.includes('before after'));
  assert.equal(sent.length, 1, 'rebuild should reuse text without fetching another tail');
  ui.unmountTerm('1');
  assert.equal(replacement.textContent, '');
  const allocations = created();
  for (let i = 0; i < 1000; i++) ui.onLogs({ rows: [row('unseen'.repeat(1000), i + 1)] });
  ui.onLogs({ reset: true, taskId: 1, rows: [row('late tail')] });
  assert.equal(created(), allocations);
  ui.mountTerm('1', replacement);
  assert.equal(replacement.textContent, '');
  assert.equal(sent.length, 2);
  ui.onLogs({ rows: [row('deleted')] });
  ui.prepareTasks([]);
  assert.equal(replacement.textContent, '');
});

function shellHarness() {
  const ends = new Set();
  let timeout;
  let next;
  let reads = 0;
  let returned = 0;
  const execution = { read: () => ({ [Symbol.asyncIterator]: () => ({
    next() { reads++; return new Promise(resolve => { next = resolve; }); },
    async return() { returned++; return { done: true }; },
  }) }) };
  const { collect } = load('src/editorTerminal.ts', { vscode: { window: {
    onDidEndTerminalShellExecution(fn) { ends.add(fn); return { dispose: () => ends.delete(fn) }; },
  } } }, { setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {} }, '\nexport { collect };');
  return { collect: () => collect(execution, 1000),
    async chunk(value) { next({ value, done: false }); await new Promise(setImmediate); },
    async finish() { next({ done: true }); await new Promise(setImmediate); },
    end() { for (const fn of ends) fn({ execution, exitCode: 0 }); },
    timeout: () => timeout(), ends, reads: () => reads, returned: () => returned };
}

test('terminal timeout stops reading and retains only a bounded diagnostic tail', async () => {
  const h = shellHarness();
  const pending = h.collect();
  await h.chunk('x'.repeat(2_000_000) + 'last output');
  h.timeout();
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.ok(result.output.startsWith('[Earlier terminal output truncated]'));
  assert.ok(result.output.endsWith('last output'));
  assert.ok(result.output.length < 263_000);
  assert.equal(h.ends.size, 0);
  assert.equal(h.returned(), 1);
  const reads = h.reads();
  await h.chunk('late output');
  assert.equal(h.reads(), reads, 'reader must not pull any more chunks after timeout');
});

test('terminal exit drains trailing output before completing', async () => {
  const h = shellHarness();
  const pending = h.collect();
  await h.chunk('start\n');
  h.end();
  await h.chunk('last diagnostic');
  await h.finish();
  const result = await pending;
  assert.equal(result.output, 'start\nlast diagnostic');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(h.ends.size, 0);
});

test('statement reuse has a bounded LRU and clears native references on close', () => {
  const { cachedDriver } = load('src/queue/dbDriver.ts');
  let prepared = 0;
  let closed = false;
  const driver = cachedDriver({ prepare: sql => ({ sql, serial: ++prepared }), exec() {}, close() { closed = true; } });
  const hot = driver.prepare('hot');
  for (let i = 0; i < 10_000; i++) assert.equal(driver.prepare('hot'), hot);
  assert.equal(prepared, 1);
  for (let i = 0; i < 128; i++) driver.prepare(`query ${i}`);
  assert.notEqual(driver.prepare('hot'), hot);
  const beforeDDL = driver.prepare('hot');
  driver.exec('ALTER TABLE tasks ADD COLUMN example TEXT');
  assert.notEqual(driver.prepare('hot'), beforeDDL);
  driver.close();
  assert.equal(closed, true);
});

test('disposed transports release handlers and reject further requests', async () => {
  const { CoreTransport } = load('src/runtime/coreTransport.ts');
  const client = new CoreTransport({ binary: '', cwd: '', output: { appendLine() {} } });
  client.onNotification(() => {});
  client.onRequest('example', async () => {});
  client.dispose();
  assert.equal(client.notifications.size, 0);
  assert.equal(client.handlers.size, 0);
  await assert.rejects(client.request('example'), /disposed/);
});

test('LM proxy releases cancellation tokens and close listeners on errors and successful replies', async () => {
  let disposed = 0;
  class TextPart { constructor(value) { this.value = value; } }
  const { LmProxy } = load('src/llm/lmProxy.ts', { vscode: {
    CancellationTokenSource: class { token = {}; cancel() {} dispose() { disposed++; } },
    LanguageModelChatToolMode: { Auto: 1 },
    LanguageModelChatMessage: { User: value => ({ content: Array.isArray(value) ? value : [new TextPart(value)] }) },
    LanguageModelTextPart: TextPart,
    CancellationError: class extends Error {},
    LanguageModelError: class extends Error {},
  } });
  const proxy = new LmProxy({ appendLine() {} });
  proxy.pick = async () => ({ id: 'test', sendRequest: async () => { throw new Error('failed'); } });
  const response = new EventEmitter();
  for (let i = 0; i < 100; i++) {
    await assert.rejects(proxy.chat({ messages: [{ role: 'user', content: 'hello' }] }, response), /failed/);
    assert.equal(response.listenerCount('close'), 0);
  }
  assert.equal(disposed, 100);
  proxy.pick = async () => ({ id: 'test', countTokens: async () => 1,
    sendRequest: async () => ({ stream: (async function* () { yield new TextPart('hello'); })() }) });
  let sent = '';
  response.writeHead = response.flushHeaders = () => {};
  response.write = value => { sent += value; return true; };
  response.end = value => { sent += value ?? ''; };
  for (const stream of [true, false]) {
    sent = '';
    await proxy.chat({ stream, messages: [{ role: 'user', content: 'hello' }] }, response);
    assert.ok(sent.includes('hello'));
    assert.equal(response.listenerCount('close'), 0);
  }
  assert.equal(disposed, 102);
});

test('queue live polling omits stored reports and output with the real SQLite driver', async () => {
  const { createHost } = require('./headless-host.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-memory-'));
  const host = await createHost({ workspace: root, log() {} });
  try {
    host.queue.replaceAll([{ title: 'live', description: 'work' }, { title: 'idle', description: 'wait' }]);
    const task = host.queue.claimNext();
    host.queue.update(task.id, { output: 'x'.repeat(1_000_000) });
    host.queue.recordActivity(task.id, 'tool', 'building', 'executor');
    assert.equal(host.queue.activeTaskId(), task.id);
    // A status heartbeat must not fall back to reading the task's large output.
    host.queue.activeTask = () => { throw new Error('full task read during status poll'); };
    assert.equal(host.runner.status().currentTaskId, task.id);
    for (let i = 0; i < 1000; i++) {
      const rows = host.queue.liveTasks();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, task.id);
      assert.equal(rows[0].activityDetail, 'building');
      assert.equal(rows[0].output, undefined);
      assert.ok(JSON.stringify(rows).length < 500);
    }
    assert.equal(host.queue.get(task.id).output.length, 1_000_000);

    const { QueueViewProvider } = host.load('src/queue/panel.ts');
    const provider = new QueueViewProvider(host.context, host.output, async () => {});
    const listeners = new Set();
    const orch = { onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
    provider.render = () => {};
    try {
      for (let i = 0; i < 100; i++) provider.attach(host.queue, orch);
      assert.equal(listeners.size, 1);
      provider.view = { visible: true };
      provider.syncStreaming();
      assert.ok(provider.streamTimer);
      provider.dispose();
      assert.equal(provider.streamTimer, undefined);
      assert.equal(listeners.size, 0);
      assert.equal(provider.view, undefined);
      assert.equal(provider.queue, undefined);
    } finally { provider.dispose(); }
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
