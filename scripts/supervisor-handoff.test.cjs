// Real queue, scheduler and SQLite. Only the replacement planner is simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 };
const parts = ['Inspect headings', 'Inspect identifiers'].map(title => ({ title,
  description: `${title}; preserve the existing document and record exact evidence.`,
  solutionVerifyPrompt: `Record ${title} evidence.` }));
const decision = { verdict: 'SPLIT', feedback: 'Partition the remaining checks.', splitInto: parts, usage };

test('supervisor recovery after verification handoff', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-supervisor-handoff-'));
  const host = await createHost({ workspace: root, log() {}, settings: { 'queue.verificationMaxInteractions': 2 } });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const { VerificationBudget } = host.load('src/queue/verificationBudget.ts');
  const recovery = host.load('src/queue/recoveryDecomposition.ts');
  const planner = host.load('src/queue/failureDecomposition.ts');
  const original = planner.decideFailureDecomposition;
  let now = Date.now(), number = 0;
  t.mock.method(Date, 'now', () => now);

  function fixture() {
    const file = path.join(root, '.mfagent', `handoff-${++number}.db`);
    const queue = TaskQueue.open(file);
    queue.insert({ title: 'Verify generated checklist', description: 'Inspect headings and identifiers.',
      solutionVerifyPrompt: 'Record read-only evidence.',
      status: 'VERIFYING' }, 1);
    queue.setRunState('RUNNING');
    const task = queue.list()[0];
    queue.update(task.id, { output: 'Existing implementation must survive recovery.' });
    const budget = new VerificationBudget(2, queue, task);
    budget.consume('plan'); budget.consume('plan repair');
    const logs = [];
    const runner = new Orchestrator(host.context, { appendLine: line => logs.push(line) }, queue);
    runner.wakeAfterHandoff = () => {};
    runner.pump = async () => {};
    let closed = false;
    return { queue, runner, task, file, logs,
      close() { if (!closed) { runner.dispose(); queue.close(); closed = true; } } };
  }

  function pendingPlanner() {
    const calls = [];
    planner.decideFailureDecomposition = async (_context, _output, _task, _input, opts) => {
      let resolve;
      const pending = new Promise(done => { resolve = done; });
      const call = { opts, resolve, aborted: 0 };
      calls.push(call);
      // Deliberately ignore cancellation: the scheduler must fence late results.
      opts.onAbort(() => { call.aborted++; });
      opts.onActivity({ phase: 'model_wait', detail: 'waiting for the first token from test-planner', at: now });
      return pending;
    };
    return calls;
  }

  async function startPlanning(f) {
    await f.runner.tick();
    assert.ok(recovery.requiresDecomposition(f.queue.get(f.task.id)));
    const running = f.runner.tick();
    await new Promise(resolve => setImmediate(resolve));
    return { running };
  }

  try {
    await t.test('planner wait is visible on the task rather than a stale generic activity', async () => {
      const f = fixture(), calls = pendingPlanner();
      let running;
      try {
        ({ running } = await startPlanning(f));
        assert.equal(calls.length, 1);
        const task = f.queue.get(f.task.id);
        assert.equal(task.activityPhase, 'decomposition_planning');
        assert.match(task.activityDetail, /waiting for the first token from test-planner/);
      } finally {
        f.runner.dispose(); calls.forEach(call => call.resolve(decision));
        await running; f.close();
      }
    });

    await t.test('transport heartbeats cannot hold the queue busy without model output', async () => {
      const f = fixture(), calls = pendingPlanner();
      let running;
      try {
        ({ running } = await startPlanning(f));
        for (let i = 0; i < 5; i++) {
          now += 30_000;
          calls[0].opts.onActivity({ phase: 'model_wait', detail: 'connection alive; no model output yet', at: now });
        }
        await f.runner.tick();
        assert.equal(calls[0].aborted, 1, 'cancel the no-output planner even though its connection is alive');
        assert.equal(f.runner.status().supervising, false);
        assert.equal(calls.length, 1, 'respect backoff before retrying');
        const task = f.queue.get(f.task.id);
        assert.equal(task.activityPhase, 'decomposition_waiting');
        assert.match(task.activityDetail, /no model output/i);
        assert.equal(task.output, 'Existing implementation must survive recovery.');
        const job = recovery.readDecomposition(f.queue, task);
        assert.ok(job.dueAt > now);
        calls[0].resolve(decision);
        await running;
        assert.ok(f.queue.get(f.task.id), 'ignore a successful response from the abandoned planner');
        now = job.dueAt + 1;
        planner.decideFailureDecomposition = async () => decision;
        await f.runner.tick();
        assert.equal(f.queue.get(f.task.id), undefined, f.logs.join('\n'));
        assert.deepEqual(f.queue.list().map(row => row.status), ['PENDING', 'PENDING']);
      } finally {
        f.runner.dispose(); calls.forEach(call => call.resolve(decision));
        await running; f.close();
      }
    });

    await t.test('actual streamed output renews the idle deadline, not a total runtime cap', async () => {
      const f = fixture(), calls = pendingPlanner();
      let running;
      try {
        ({ running } = await startPlanning(f));
        for (let i = 0; i < 4; i++) {
          now += 90_000;
          calls[0].opts.onEvent(i % 2 ? 'stream/thinking' : 'stream/text', { delta: 'continued plan output' });
          await f.runner.tick();
          assert.equal(calls[0].aborted, 0);
          assert.equal(f.runner.status().supervising, true);
        }
        calls[0].resolve(decision);
        await running;
        assert.equal(f.queue.get(f.task.id), undefined);
      } finally {
        f.runner.dispose(); calls.forEach(call => call.resolve(decision));
        await running; f.close();
      }
    });

    await t.test('repeated no-output attempts exhaust a durable allowance without accepting late replies', async () => {
      const f = fixture(), calls = pendingPlanner(), turns = [];
      try {
        turns.push((await startPlanning(f)).running);
        for (let i = 0; i < 3; i++) {
          assert.equal(calls.length, i + 1);
          now += 150_000;
          calls[i].opts.onActivity({ phase: 'model_wait', detail: 'connection alive; no model output yet', at: now });
          await f.runner.tick();
          assert.equal(calls[i].aborted, 1);
          assert.equal(f.runner.status().supervising, false);
          const job = recovery.readDecomposition(f.queue, f.queue.get(f.task.id));
          assert.equal(job.inputs[job.fingerprint], i + 1);
          if (i < 2) {
            now = job.dueAt + 1;
            turns.push(f.runner.tick());
            await new Promise(resolve => setImmediate(resolve));
          } else {
            assert.equal(job.awaitingChange, true);
            assert.match(f.queue.get(f.task.id).activityDetail, /Recovery blocked/);
          }
        }
        const detail = f.queue.get(f.task.id).activityDetail;
        calls[0].opts.onActivity({ phase: 'done', detail: 'stale provider finished', at: now });
        calls[0].opts.onEvent('stream/text', { delta: 'late output cannot revive this review' });
        calls.forEach(call => call.resolve(decision));
        await Promise.all(turns);
        now += 3_600_000;
        await f.runner.tick();
        assert.equal(calls.length, 3);
        assert.equal(f.queue.get(f.task.id).activityDetail, detail);
        // The watchdog's silence path defers rather than plans, so an exhausted
        // no-output allowance stays VERIFYING and waits for a changed input
        // (streak, planner/provider or workspace) instead of renewing spend.
        assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
        assert.equal(f.queue.countEvents(f.task.id, 'verification-interaction'), 2);
      } finally {
        f.runner.dispose(); calls.forEach(call => call.resolve(decision));
        await Promise.all(turns); f.close();
      }
    });

    await t.test('a provider outage never spends the decomposition allowance or blocks the task', async () => {
      const f = fixture();
      let calls = 0, reopened;
      planner.decideFailureDecomposition = async () => { calls++; throw Error('Provider monthly spend limit reached'); };
      try {
        await f.runner.tick();
        for (let i = 0; i < 3; i++) {
          now += 300_000;
          await f.runner.tick();
        }
        // The spend-limit refusal never reached the model, so it is refunded
        // rather than counted: the same allowance is still available.
        assert.equal(calls, 3);
        assert.equal(f.runner.status().supervising, false);
        const task = f.queue.get(f.task.id);
        assert.equal(task.activityPhase, 'decomposition_planning');
        assert.match(task.activityDetail, /spend limit/);
        const job = recovery.readDecomposition(f.queue, task);
        assert.equal(job.awaitingChange, false);
        assert.ok(Object.values(job.inputs).every(value => value === 0), 'no allowance was spent on the outage');
        f.close();
        reopened = TaskQueue.open(f.file);
        const runner = new Orchestrator(host.context, host.output, reopened);
        runner.pump = async () => {};
        try {
          now += 3_600_000;
          await runner.tick();
          assert.equal(calls, 4);
          assert.equal(recovery.readDecomposition(reopened, reopened.get(f.task.id)).awaitingChange, false);
          assert.equal(reopened.get(f.task.id).status, 'VERIFYING');
        } finally { runner.dispose(); }
      } finally { reopened?.close(); f.close(); }
    });
  } finally {
    planner.decideFailureDecomposition = original;
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('mf-supervisor-handoff-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
