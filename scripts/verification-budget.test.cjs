// Real verification pipeline, orchestrator, and SQLite; fake provider/tool transport only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const step = { id: 'scan', requirement: 'Check the assigned template tokens', kind: 'shell',
  command: 'grep -n legacy frontend.vue', expectExitCode: 0, dependsOn: [] };
const plan = { version: 1, commandDisposition: 'none', reason: 'No saved adapter.',
  preservedAssertions: ['Keep every assigned check.'], steps: [step], remaining: [] };
const report = conclusion => JSON.stringify({ validation: { conclusion, summary: 'Checked scoped requirements.',
  implementationEvidence: 'scan: recorded source inspection', behaviorEvidence: 'scan: recorded output',
  checks: [{ stepId: 'scan', kind: 'command', name: 'Scoped scan', passed: true, evidence: 'scan: exact host output' }],
  remaining: conclusion === 'PASS' ? '' : 'Additional scoped evidence is required.' } });
const parts = ['Scan layout tokens', 'Scan component tokens'].map(title => ({ title,
  description: `${title}; preserve existing implementation and record exact read-only evidence.`,
  implVerifyPrompt: `Check scoped commands for ${title}.`, solutionVerifyPrompt: `Confirm outputs for ${title}.`,
  solutionVerifyCommand: '' }));

test('verification interaction budget', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-verification-budget-'));
  const host = await createHost({ workspace: root, log() {}, settings: { 'queue.verificationMaxInteractions': 2 } });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const { VerificationBudget } = host.load('src/queue/verificationBudget.ts');
  const { runVerification } = host.load('src/queue/verification.ts');
  const recovery = host.load('src/queue/recoveryDecomposition.ts');
  const runtime = host.load('src/queue/agentRuntime.ts');
  const core = host.load('src/core.ts');
  const bridge = host.load('src/mcpBridge.ts');
  const decomposition = host.load('src/queue/failureDecomposition.ts');
  const originals = { runOnce: runtime.runOnce, CoreClient: core.CoreClient,
    getBridge: bridge.getBridge, plan: decomposition.decideFailureDecomposition };
  let replies = [], calls = 0, tools = [], provider;
  runtime.runOnce = async (_c, _o, _role, _prompt, options) => {
    calls++;
    assert.equal(options.maxIterations, 1);
    assert.equal(options.formatOnly, true);
    if (provider) return provider(options);
    assert.ok(replies.length, 'Unexpected extra LLM interaction');
    const text = replies.shift();
    if (text instanceof Error) throw text;
    return { text, stopReason: 'end_turn', usage };
  };
  bridge.getBridge = () => ({ attach() {} });
  core.CoreClient = class {
    onRequest() {}
    async start() {}
    async initialize() {}
    dispose() {}
    async request(method, input) {
      if (method === 'tools/list') return ['unix', 'browser_layout_check'].map(name => ({ name, description: name }));
      assert.equal(method, 'tools/invoke');
      tools.push(input.name);
      return { output: 'exact host output', isError: false, meta: { exitCode: 0 } };
    }
  };
  let fixtureId = 0;
  function fixture(file = path.join(root, '.mfagent', `case-${++fixtureId}.db`)) {
    calls = 0; tools = []; replies = []; provider = undefined;
    const queue = TaskQueue.open(file);
    queue.insert({ title: 'Task 45: read-only validation', description: 'Scan scoped Vue tokens.',
      implVerifyPrompt: 'Inspect all assigned templates.', solutionVerifyPrompt: 'Record exact outputs.',
      solutionVerifyCommand: '', status: 'VERIFYING', output: 'Existing implementation handoff.' }, 45);
    queue.setRunState('RUNNING');
    const logs = [];
    const runner = new Orchestrator(host.context, { appendLine: line => logs.push(line) }, queue);
    runner.wakeAfterHandoff = () => {};
    runner.pump = async () => {};
    queue.update(queue.list()[0].id, { output: 'Existing implementation handoff.' });
    const task = queue.list()[0];
    return { queue, runner, task, logs, close() { runner.dispose(); queue.close(); } };
  }
  const verify = (f, budget) => runVerification(host.context, host.output, f.task, '',
    undefined, undefined, undefined, '', undefined, budget);

  try {
    await t.test('normal plan/report costs two interactions, not one per host tool', async () => {
      const f = fixture();
      try {
        replies = [JSON.stringify({ ...plan, steps: [step, { ...step, id: 'scan2' }] }), report('PASS')];
        const budget = new VerificationBudget(2, f.queue, f.task);
        const result = await verify(f, budget);
        assert.equal(calls, 2); assert.equal(tools.length, 2);
        assert.equal(budget.used, 2);
        assert.equal(JSON.parse(result.validationReport).conclusion, 'PASS');
      } finally { f.close(); }
    });

    await t.test('rejected-plan correction consumes budget and receipts survive blocked reporting', async () => {
      const f = fixture();
      try {
        replies = ['invalid JSON', JSON.stringify(plan), report('PASS')];
        const budget = new VerificationBudget(2, f.queue, f.task);
        await assert.rejects(verify(f, budget), error => {
          assert.equal(error.code, 'interaction_budget');
          const checkpoint = JSON.parse(error.validationReport);
          assert.equal(checkpoint.conclusion, 'INCOMPLETE');
          assert.equal(checkpoint.verificationReceipts[0].output, 'exact host output');
          return true;
        });
        assert.equal(calls, 2); assert.equal(replies.length, 1);
      } finally { f.close(); }
    });

    await t.test('slow responses and many heartbeat/stream events do not consume the budget', async () => {
      const f = fixture();
      const realNow = Date.now;
      let finish;
      try {
        const budget = new VerificationBudget(2, f.queue, f.task);
        provider = async options => {
          if (calls === 2) return { text: report('PASS'), stopReason: 'end_turn', usage };
          Date.now = () => realNow() + 12 * 60 * 60_000;
          for (let i = 0; i < 1000; i++) {
            options.onActivity?.({ phase: 'model_stream', detail: 'slow reasoning', at: Date.now() });
            options.onEvent?.('stream/thinking', { delta: 'still thinking ' });
          }
          return new Promise(resolve => { finish = resolve; });
        };
        const pending = verify(f, budget);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(budget.used, 1); assert.equal(calls, 1);
        finish({ text: JSON.stringify(plan), stopReason: 'end_turn', usage });
        await pending;
        assert.equal(budget.used, 2);
      } finally { Date.now = realNow; f.close(); }
    });

    await t.test('budget survives reload/reverification and failed requests are not free', async () => {
      const file = path.join(root, 'reload.db');
      const f = fixture(file);
      let reopened;
      try {
        replies = [Error('transport failed')];
        await assert.rejects(verify(f, new VerificationBudget(2, f.queue, f.task)), /transport failed/);
        reopened = TaskQueue.open(file);
        const budget = new VerificationBudget(2, reopened, f.task);
        assert.equal(budget.used, 1);
        budget.consume('report');
        assert.equal(new VerificationBudget(2, f.queue, f.task).used, 2);
        assert.throws(() => budget.consume('reverify'), /budget exhausted/);
        assert.equal(calls, 1);
      } finally { reopened?.close(); f.close(); }
    });

    await t.test('vision-backed checks consume interactions and preserve earlier partial receipts', async () => {
      const f = fixture();
      try {
        const vision = { id: 'vision', kind: 'tool', name: 'browser_layout_check', requirement: 'Inspect layout',
          input: {}, dependsOn: [] };
        replies = [JSON.stringify({ ...plan, steps: [step, vision, { ...vision, id: 'vision2' }] })];
        const budget = new VerificationBudget(2, f.queue, f.task);
        await assert.rejects(verify(f, budget), error => {
          assert.equal(error.code, 'interaction_budget');
          assert.equal(JSON.parse(error.validationReport).verificationReceipts.length, 2);
          return true;
        });
        assert.equal(budget.used, 2); assert.equal(calls, 1);
        assert.deepEqual(tools, ['unix', 'browser_layout_check']);
      } finally { f.close(); }
    });

    await t.test('exhausted incomplete verification goes directly to atomic split, not another review', async () => {
      const f = fixture();
      try {
        replies = [JSON.stringify(plan), report('INCOMPLETE')];
        decomposition.decideFailureDecomposition = async () => ({ verdict: 'SPLIT', feedback: 'Partition remaining checks.', splitInto: parts, usage });
        await f.runner.tick();
        assert.ok(recovery.requiresDecomposition(f.queue.get(f.task.id)));
        assert.equal(calls, 2);
        const saved = JSON.parse(f.queue.get(f.task.id).validationReport);
        assert.equal(saved.verificationReceipts[0].output, 'exact host output');
        await f.runner.tick();
        assert.equal(f.queue.get(f.task.id), undefined, f.logs.join('\n'));
        const children = f.queue.list();
        assert.equal(children.length, 2);
        assert.deepEqual(children.map(row => row.status), ['PENDING', 'PENDING']);
        const archived = JSON.parse(f.queue.getMeta(JSON.parse(children[0].region).scopeSplit.archiveKey));
        assert.equal(archived.task.output, f.task.output);
        assert.equal(archived.events.filter(e => e.kind === 'verification-interaction').length, 2);
        assert.equal(calls, 2);
      } finally { f.close(); }
    });

    await t.test('a host-backed PASS on the final allowed interaction is accepted', async () => {
      const f = fixture();
      try {
        replies = [JSON.stringify(plan), report('PASS')];
        await f.runner.tick();
        assert.equal(calls, 2);
        assert.equal(f.queue.get(f.task.id).status, 'VERIFIED');
        assert.equal(recovery.readDecomposition(f.queue, f.task), undefined);
      } finally { f.close(); }
    });

    await t.test('already exhausted tasks never launch a verifier; configuration cannot disable the cap', async () => {
      const f = fixture();
      try {
        const budget = new VerificationBudget(2, f.queue, f.task);
        budget.consume('plan'); budget.consume('report');
        await f.runner.tick();
        assert.equal(calls, 0);
        assert.ok(recovery.requiresDecomposition(f.queue.get(f.task.id)));
        for (const [value, expected] of [[0, 1], [-1, 1], [2.9, 2], [NaN, 4], [Infinity, 4]]) {
          assert.equal(new VerificationBudget(value).limit, expected);
        }
      } finally { f.close(); }
    });
  } finally {
    runtime.runOnce = originals.runOnce; core.CoreClient = originals.CoreClient;
    bridge.getBridge = originals.getBridge; decomposition.decideFailureDecomposition = originals.plan;
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('mf-verification-budget-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
