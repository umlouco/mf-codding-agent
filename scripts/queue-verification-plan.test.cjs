const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const capabilities = ['unix', 'read_file', 'grep', 'browser_open', 'browser_eval', 'write_file'].map(name =>
  ({ name, description: name, inputSchema: { type: 'object' }, mutating: name !== 'read_file' }));
const shell = (id = 'absence', command = "grep -r 'forbidden' src") => ({ id, requirement: 'Forbidden values are absent',
  kind: 'shell', command, expectExitCode: 1, dependsOn: [] });
const browser = (id = 'page') => ({ id, requirement: 'Real browser renders the assigned behavior', kind: 'tool',
  name: 'browser_open', input: { url: 'http://example.test' }, dependsOn: [] });
const plan = (steps, patch = {}) => ({ version: 1, commandDisposition: 'none', reason: '',
  preservedAssertions: [], steps, remaining: [], ...patch });
const passing = () => ({ validation: { conclusion: 'PASS', summary: 'Observed assigned behavior',
  implementationEvidence: 'inspected source through receipt inspect', behaviorEvidence: 'Observed receipt absence',
  checks: [{ stepId: 'absence', kind: 'test', name: 'Required check', passed: true, evidence: 'receipt absence passed' }], remaining: '' } });

test('a broken shell checker never becomes an executed failed product assertion', () => {
  const f = fixture();
  const { verificationReceipt } = f.load('verificationPlan');
  for (const expected of [0, 127]) {
    const result = verificationReceipt({ ...shell(), expectExitCode: expected },
      { output: 'missing-check: command not found', isError: true, meta: { exitCode: 127 } });
    assert.equal(result.executionSucceeded, false);
    assert.equal(result.passed, false);
    assert.match(result.problem, /invocation failure/);
  }
  const inconsistent = verificationReceipt({ ...shell(), expectExitCode: 0 },
    { output: 'Opaque tool failure', isError: true, meta: { exitCode: 0 } });
  assert.equal(inconsistent.executionSucceeded, false);
  assert.equal(inconsistent.passed, false);
});

test('decoding an inspection tool as JSON is an invalid check, not an observed product defect', () => {
  const f = fixture();
  const { verificationReceipt } = f.load('verificationPlan');
  const result = verificationReceipt({ ...browser(), name: 'read_file', expect: { jsonEquals: {} } },
    { output: '1: source code displayed with line numbers', isError: false });
  assert.equal(result.executionSucceeded, true);
  assert.equal(result.passed, false);
  assert.equal(result.assertion, 'invalid');
});

function fixture(options = {}) {
  const cache = new Map();
  const calls = [], clients = [], prompts = [], events = [];
  class CoreClient {
    constructor() { this.disposed = false; clients.push(this); }
    async start() {}
    async initialize(config) { this.config = config; }
    async request(method, params) {
      assert.equal(this.disposed, false, 'no work after cancellation');
      if (method === 'tools/list') return capabilities;
      assert.equal(method, 'tools/invoke'); calls.push(params);
      return options.invoke ? options.invoke(params, calls.length) :
        { output: params.name === 'unix' ? 'exit=1\n(no output)' : 'observed source', isError: params.name === 'unix', meta: { exitCode: 1 } };
    }
    dispose() { this.disposed = true; }
  }
  const deps = {
    '../core': { CoreClient }, '../editorFs': { registerEditorFsHandlers() {} },
    '../mcpBridge': { getBridge: () => ({ attach() {} }) }, './registry': {},
    './agents': { coreHalted: reason => reason === 'max_iterations',
      runOnce: async (_, __, ___, prompt, opts) => {
        prompts.push({ prompt, opts });
        const value = options.responses ? options.responses[prompts.length - 1] :
          prompts.length === 1 ? options.plan || plan([shell()]) : options.report || passing();
        if (value instanceof Error) throw value;
        return { text: JSON.stringify(value), stopReason: '', usage };
      } },
  };
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    cache.set(name, exports);
    const source = fs.readFileSync(path.join(__dirname, '../src/queue', name + '.ts'), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 } }).outputText, { exports, Buffer, process, setTimeout, clearTimeout, setInterval, clearInterval,
      require: dependency => deps[dependency] ?? (dependency === 'crypto' ? require('node:crypto') :
        dependency.startsWith('./') ? load(dependency.slice(2)) : {}) });
    return exports;
  }
  return { load, calls, clients, prompts, events };
}

const parser = fixture().load('verificationPlan');
test('typed plan preserves absence semantics without treating tool RPCs as shell commands', () => {
  const raw = plan([shell(), browser()], { commandDisposition: 'adapted', reason: 'Absence returns 1; browser is an RPC.',
    preservedAssertions: ['Forbidden values absent and UI renders'] });
  const parsed = parser.parseVerificationPlan(JSON.stringify(raw), "grep -r forbidden src && browser_open URL", capabilities);
  assert.equal(parsed.steps[0].expectExitCode, 1);
  assert.equal(parsed.steps[1].name, 'browser_open');
  assert.equal(parser.verificationReceipt(parsed.steps[0], { output: '', isError: true, meta: { exitCode: 1 } }).passed, true);
  assert.equal(parser.verificationReceipt(parsed.steps[0], { output: 'bad path', isError: true, meta: { exitCode: 2 } }).passed, false);
  assert.equal(parser.verificationReceipt(parsed.steps[0], { output: 'parse error', isError: true }).passed, false);
});

test('registered JSON schemas reject wrong tool input before invoking anything', () => {
  const registry = [{ name: 'browser_open', description: 'Open target', inputSchema: {
    type: 'object', required: ['url'], properties: { url: { type: 'string' } }, additionalProperties: false } }];
  for (const input of [{}, { url: 45 }, { url: 'http://example.test', invented: true }]) {
    assert.throws(() => parser.parseVerificationPlan(JSON.stringify(plan([{ ...browser(), input }])), '', registry), /missing|type|not registered/);
  }
});

test('a host-shell wrapper or missing executable cannot masquerade as a successful absence check', () => {
  for (const command of ['cmd /c grep forbidden src', 'printf ok && powershell.exe -Command missing']) {
    assert.throws(() => parser.parseVerificationPlan(JSON.stringify(plan([shell('check', command)])), '', capabilities), /host-shell wrappers/);
  }
  const receipt = parser.verificationReceipt(shell(), { output: 'grep is not recognized as an internal or external command',
    isError: true, meta: { exitCode: 1 } });
  assert.equal(receipt.passed, false);
  assert.match(receipt.problem, /invocation failure/);
});

test('a single bounded plan correction retains its cost and executes only the corrected plan', async () => {
  const corrected = plan([shell()]);
  const f = fixture({ responses: [{ invalid: true }, corrected, passing()] });
  const result = await f.load('verification').runVerification({}, {}, { id: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal');
  assert.equal(f.prompts.length, 3);
  assert.equal(f.calls.length, 1);
  assert.equal(result.usage.input, 30);
  const rejected = fixture({ responses: [{ invalid: true }, { invalid: true }] });
  await assert.rejects(rejected.load('verification').runVerification({}, {}, { id: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal'),
    error => error.name === 'VerificationPlanError' && error.usage.input === 20);
  assert.equal(rejected.calls.length, 0);
});

test('a reporter failure preserves actual receipts and already-spent planning usage', async () => {
  const f = fixture({ responses: [plan([shell()]), Error('report endpoint disconnected')] });
  await assert.rejects(f.load('verification').runVerification({}, {}, { id: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal'), error => {
    assert.equal(error.usage.input, 10);
    const checkpoint = JSON.parse(error.validationReport);
    assert.equal(checkpoint.conclusion, 'INCOMPLETE');
    assert.equal(checkpoint.verificationReceipts[0].exitCode, 1);
    return true;
  });
});

test('nested model usage from direct verification tools is counted once with planning and reporting', async () => {
  const f = fixture({ invoke: async () => ({ output: 'exit=1', isError: true, meta: { exitCode: 1 },
    usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 0 } }) });
  const result = await f.load('verification').runVerification({}, {}, { id: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal');
  assert.equal(result.usage.input, 25);
  assert.equal(result.usage.output, 7);
  assert.equal(result.usage.cacheRead, 2);
});

test('a browser claim cannot bind an inspection receipt merely because some other browser call succeeded', async () => {
  const inspected = { id: 'inspect', requirement: 'Inspect source', kind: 'tool', name: 'read_file', input: { path: 'source' }, dependsOn: [] };
  const f = fixture({ plan: plan([inspected, browser()]), invoke: async () => ({ output: 'source or browser state', isError: false }),
    report: { validation: { ...passing().validation, checks: [{ stepId: 'inspect', kind: 'browser', name: 'Imagined runtime', passed: true, evidence: 'inspect' }] } } });
  const outcome = await f.load('verification').runVerification({}, {}, { id: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal');
  assert.equal(JSON.parse(outcome.validationReport).conclusion, 'INCOMPLETE');
});

test('a browser evaluation that merely returned false is not a passing behavior assertion', async () => {
  const observed = { id: 'state', requirement: 'The required state exists', kind: 'tool', name: 'browser_eval',
    input: { expression: 'document.querySelector("svg") !== null' }, dependsOn: [] };
  const receipt = parser.verificationReceipt(observed, { output: 'false', isError: false });
  assert.equal(receipt.executionSucceeded, true);
  assert.equal(receipt.assertion, 'unasserted');
  const f = fixture({ plan: plan([observed]), invoke: async () => ({ output: 'false', isError: false }),
    report: { validation: { ...passing().validation, checks: [{ stepId: 'state', kind: 'browser', name: 'State', passed: true, evidence: 'state' }] } } });
  const outcome = await f.load('verification').runVerification({}, {}, { id: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal');
  assert.equal(JSON.parse(outcome.validationReport).conclusion, 'INCOMPLETE');
});

test('host-proven generated-adapter authority does not mutate the task or become sibling acceptance', async () => {
  const f = fixture();
  const task = { id: 132, seq: 45, createdAt: 1, description: 'Assigned local acceptance',
    solutionVerifyCommand: 'invalid generated adapter', validationReport: 'Previous failed host evidence' };
  const authority = { source: 'extension-generated', originalCommand: '', adapter: task.solutionVerifyCommand,
    eventId: 77, reason: 'Exact journal proves extension invented this adapter from an empty command.' };
  const snapshot = JSON.stringify(task);
  const result = await f.load('verification').runVerification({}, {}, task, 'Full owner goal', undefined, undefined, undefined, '', authority);
  const checkpoint = JSON.parse(result.validationReport).verificationPlan;
  assert.equal(checkpoint.effectiveCommand, '');
  assert.equal(checkpoint.sourceCommand, task.solutionVerifyCommand);
  assert.equal(checkpoint.commandAuthority.eventId, 77);
  assert.match(f.prompts[0].prompt, /not additional acceptance requirements/);
  assert.match(f.prompts[0].prompt, /Previous failed host evidence/);
  assert.equal(JSON.stringify(task), snapshot);
});

test('a non-shell tool deadline retires its process without losing work or running dependent steps', async () => {
  let complete;
  const f = fixture({ invoke: () => new Promise(resolve => { complete = resolve; }) });
  const session = new (f.load('verificationPlanRunner').VerificationSession)({}, {}, (_, event) => f.events.push(event));
  await session.start({});
  const receipts = await session.execute(plan([{ ...browser(), timeoutMs: 1000 }, browser('later')]));
  assert.equal(f.calls.length, 1);
  assert.equal(f.clients[0].disposed, true);
  assert.match(receipts[0].problem, /1000ms/);
  assert.match(receipts[1].problem, /Not executed/);
  complete({ output: 'late PASS', isError: false });
  assert.equal(f.events.filter(event => event.status === 'ok').length, 0);
  session.stop();
});

test('all plan shape and capability failures are rejected before invocation', () => {
  const cases = [plan(Array.from({ length: 25 }, (_, i) => shell(String(i)))), plan([{ ...browser(), name: 'imaginary_tool' }]),
    plan([{ ...browser(), name: 'write_file' }]), plan([{ ...shell(), expectExitCode: undefined }]),
    plan([{ ...shell(), command: 'browser_open http://example.test' }]), plan([shell(), shell()]),
    plan([{ ...shell(), dependsOn: ['later'] }]), plan([])];
  for (const value of cases) assert.throws(() => parser.parseVerificationPlan(JSON.stringify(value), '', capabilities));
  assert.doesNotThrow(() => parser.parseVerificationPlan(JSON.stringify(plan([{ ...shell(), command: `printf '%s' 'browser_open URL'` }])), '', capabilities));
  assert.throws(() => parser.parseVerificationPlan(JSON.stringify(plan([shell()])), 'saved check', capabilities), /cannot disappear/);
});

test('real session dispatches shell and browser separately, failing only dependants', async () => {
  const f = fixture({ invoke: async ({ name }) => name === 'unix'
    ? { output: 'failed', isError: true, meta: { exitCode: 2 } }
    : { output: 'browser opened', isError: false } });
  const session = new (f.load('verificationPlanRunner').VerificationSession)({}, {}, (_, event) => f.events.push(event));
  await session.start({});
  const receipts = await session.execute(plan([shell(), { ...browser('dependent'), dependsOn: ['absence'] }, browser('independent'), shell('renamed')]));
  assert.deepEqual(f.calls.map(call => call.name), ['unix', 'browser_open']);
  assert.equal(receipts[0].passed, false);
  assert.match(receipts[1].problem, /prerequisite/);
  assert.equal(receipts[2].passed, true);
  assert.match(receipts[3].problem, /already failed/);
  session.stop(); assert.equal(f.clients[0].disposed, true);
});

test('cancellation disposes the owned process and cannot execute the next step or emit a false receipt', async () => {
  let finish;
  const f = fixture({ invoke: () => new Promise(resolve => { finish = resolve; }) });
  const session = new (f.load('verificationPlanRunner').VerificationSession)({}, {}, (_, event) => f.events.push(event));
  await session.start({});
  const running = session.execute(plan([browser(), browser('later')]));
  session.stop(); finish({ output: 'late result', isError: false });
  await assert.rejects(running, /cancelled/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.filter(event => event.status === 'ok').length, 0);
});

test('default verification plans, host-executes, and reports; task contract stays unchanged', async () => {
  const f = fixture();
  const task = { id: 1, seq: 45, createdAt: 1, title: 'Assigned behavior', description: 'No forbidden values.',
    implVerifyPrompt: 'Inspect actual source', solutionVerifyPrompt: 'Check absence', solutionVerifyCommand: '', output: 'Untrusted PASS' };
  const before = JSON.stringify(task);
  const outcome = await f.load('verification').runVerification({}, {}, task, 'Owner objective');
  const report = JSON.parse(outcome.validationReport);
  assert.equal(report.conclusion, 'PASS');
  assert.equal(report.verificationReceipts[0].exitCode, 1);
  assert.equal(report.observedTools.length, 1);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts.every(entry => entry.opts.formatOnly));
  assert.match(f.prompts[0].prompt, /inputSchema/);
  assert.match(f.prompts[1].prompt, /HOST RECEIPTS/);
  assert.equal(outcome.usage.input, 20);
  assert.equal(JSON.stringify(task), before);
});

test('fabricated PASS with zero receipts, failed receipt, or unobserved browser is never accepted', async () => {
  const scenarios = [
    { plan: plan([], { remaining: ['Missing actual inspections'] }), report: passing() },
    { invoke: async () => ({ output: 'bad path', isError: true, meta: { exitCode: 2 } }), report: passing() },
    { report: { validation: { ...passing().validation, behaviorEvidence: 'Browser screenshot showed success' } } },
  ];
  for (const scenario of scenarios) {
    const f = fixture(scenario);
    const result = await f.load('verification').runVerification({}, {}, { id: 1, seq: 1, createdAt: 1, solutionVerifyCommand: '' }, 'Goal');
    assert.equal(JSON.parse(result.validationReport).conclusion, 'INCOMPLETE');
  }
});

