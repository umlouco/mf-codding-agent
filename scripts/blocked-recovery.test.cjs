const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('unfinished tasks return to the executor before later work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-blocked-recovery-'));
  const host = await createHost({ workspace: root, log() {} });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const { scheduleRecoveryJob, hasOutstandingRecovery } = host.load('src/queue/recoverySchedule.ts');
  let number = 0;
  const fresh = () => {
    const queue = TaskQueue.open(path.join(root, `queue-${++number}.db`));
    queue.setRunState('RUNNING');
    return queue;
  };
  const add = (queue, status = 'PENDING') => {
    queue.insert({ title: 'Task', description: 'Preserve this scope.',
      solutionVerifyPrompt: 'Run the required checks.', status, maxAttempts: 1 }, queue.list().length + 1);
    return queue.list().at(-1);
  };
  try {
    await t.test('reload recovers blocked decomposition rows and retains evidence', () => {
      let queue = fresh();
      const file = queue.path;
      const task = add(queue, 'BLOCKED');
      queue.update(task.id, { attempts: 8, output: 'partial work', errorLog: 'missing Chromium',
        validationReport: 'checks failed', supervisorFeedback: 'Install Chromium and rerun.',
        activityPhase: 'decomposition_required', finishedAt: 123 });
      queue.addUsage(task.id, { input: 900, output: 20, cacheRead: 0, cacheWrite: 0 });
      const before = queue.get(task.id);
      scheduleRecoveryJob(queue, before, 'legacy recovery');
      add(queue);
      assert.equal(queue.isComplete(), false);
      queue.close();
      queue = TaskQueue.open(file);
      try {
        const recovered = queue.get(task.id);
        assert.equal(before.tokensIn, 900);
        assert.equal(recovered.status, 'PENDING');
        assert.equal(recovered.finishedAt, null);
        for (const field of ['description', 'solutionVerifyPrompt', 'attempts', 'output', 'errorLog',
          'validationReport', 'supervisorFeedback', 'tokensIn']) assert.equal(recovered[field], before[field]);
        assert.equal(hasOutstandingRecovery(queue), false);
        assert.equal(queue.claimNext().id, task.id);
        assert.equal(queue.get(task.id).attempts, 9);
        assert.equal(queue.claimNext(), undefined, 'only one worker may execute');
      } finally { queue.close(); }
    });

    await t.test('blocked work inserted during a run is retried before pending work', () => {
      const queue = fresh();
      try {
        const first = add(queue, 'BLOCKED');
        const second = add(queue, 'BLOCKED');
        const third = add(queue);
        for (const expected of [first, second, third]) {
          const claimed = queue.claimNext();
          assert.equal(claimed.id, expected.id);
          queue.finishExecution(claimed.id, claimed.attempts, { status: 'VERIFIED', finishedAt: Date.now() });
        }
        assert.equal(queue.isComplete(), true);
      } finally { queue.close(); }
    });

    await t.test('review and paused predecessors cannot be skipped by a claim', () => {
      for (const status of ['VERIFYING', 'PAUSED']) {
        const queue = fresh();
        try {
          add(queue, status);
          add(queue);
          assert.equal(queue.claimNext(), undefined);
          assert.equal(queue.isComplete(), false);
        } finally { queue.close(); }
      }
    });

    await t.test('a later supervisor repair waits for earlier blocked work', async () => {
      const queue = fresh();
      const runner = new Orchestrator(host.context, host.output, queue);
      try {
        const first = add(queue, 'BLOCKED');
        const second = add(queue, 'VERIFYING');
        queue.update(second.id, { supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] Fix the fixture.' });
        const repairs = [];
        runner.repairTests = async task => { repairs.push(task.id); };
        await runner.serviceTestRepairs();
        assert.deepEqual(repairs, []);
        queue.update(first.id, { status: 'VERIFIED' });
        await runner.serviceTestRepairs();
        assert.deepEqual(repairs, [second.id]);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('legacy incomplete and decomposition reports return to execution', () => {
      const queue = fresh();
      try {
        const first = add(queue, 'VERIFYING');
        const second = add(queue, 'FAILED');
        queue.update(first.id, { output: '{"completion":{"status":"NEEDS_MORE_WORK"}}', attempts: 5 });
        queue.update(second.id, { output: '{"completion":{"status":"READY_FOR_VALIDATION"}}' });
        queue.drainVerification();
        assert.deepEqual(queue.list().map(task => task.status), ['PENDING', 'PENDING']);
        assert.equal(queue.claimNext().id, first.id);
      } finally { queue.close(); }
    });

    await t.test('unfinished outcomes retry beyond maxAttempts in both modes', async () => {
      const agents = host.load('src/queue/agentExecution.ts');
      const original = agents.executeTask;
      try {
        for (const mode of ['lockstep', 'continuous']) {
          const queue = fresh();
          const runner = new Orchestrator(host.context, host.output, queue);
          const first = add(queue);
          const second = add(queue);
          const executions = [];
          runner.cfg = (key, fallback) => key === 'queue.mode' ? mode : fallback;
          runner.correctTestingTarget = () => false;
          runner.wakeAfterHandoff = () => {};
          runner.schedule = () => {};
          // The pre-execution scope review is a model turn; this test isolates
          // the execution-retry state machine, so let every task through.
          runner.scopeWatch = () => ({ preflight: async () => true, observe() {}, close() {} });
          agents.executeTask = async (_context, _output, task) => {
            executions.push(task.id);
            if (executions.length === 2) throw Error('connection lost');
            const done = executions.length >= 4;
            return { ok: true, cutOff: false, text: done ? 'done' : 'unfinished', notes: '',
              completion: { status: done ? 'READY_FOR_VALIDATION' : 'NEEDS_MORE_WORK',
                summary: 'result', filesChanged: [], developmentChecks: [] },
              usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } };
          };
          try {
            for (let attempt = 0; attempt < 5; attempt++) await runner.pump();
            assert.deepEqual(executions, [first.id, first.id, first.id, first.id, second.id]);
            assert.equal(queue.get(first.id).attempts, 4);
            assert.match(queue.get(first.id).errorLog, /connection lost/);
            assert.equal(queue.stats().byStatus.BLOCKED, 0);
          } finally { runner.dispose(); queue.close(); }
        }
      } finally { agents.executeTask = original; }
    });

    await t.test('silent exhausted workers retry and reject late results', () => {
      const queue = fresh();
      const runner = new Orchestrator(host.context, host.output, queue);
      try {
        add(queue);
        const active = queue.claimNext();
        queue.db.prepare('UPDATE tasks SET last_activity_at = ? WHERE id = ?')
          .run(Date.now() - 3_600_000, active.id);
        runner.sweepSilentWorkers();
        assert.equal(queue.get(active.id).status, 'PENDING');
        assert.equal(queue.finishExecution(active.id, active.attempts, { status: 'VERIFIED' }), false);
        const retry = queue.claimNext();
        assert.equal(retry.id, active.id);
        assert.equal(retry.attempts, 2);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('task handoffs and run breakers never leave terminal blocked rows', async () => {
      const queue = fresh();
      const runner = new Orchestrator(host.context, host.output, queue);
      try {
        const first = add(queue);
        add(queue);
        runner.blockTask(queue.claimNext(), 'review did not finish');
        assert.equal(queue.get(first.id).status, 'PENDING');
        assert.match(queue.get(first.id).errorLog, /review did not finish/);
        runner.cfg = (key, fallback) => key === 'queue.maxRunTasks' ? 1 : fallback;
        await runner.pump();
        // A tripped breaker subdivides the work; it never stops the run.
        assert.equal(queue.runState, 'RUNNING');
        assert.equal(queue.stats().byStatus.EXECUTING, 0);
        assert.equal(queue.stats().byStatus.BLOCKED, 0);
        assert.equal(queue.isComplete(), false);
      } finally { runner.dispose(); queue.close(); }
    });
  } finally {
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
