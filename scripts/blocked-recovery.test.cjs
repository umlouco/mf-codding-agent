const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('earlier unfinished work is resolved before any later task runs', async t => {
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

    await t.test('legacy incomplete reports return to execution; failed ones wait for their split', () => {
      const queue = fresh();
      try {
        const first = add(queue, 'VERIFYING');
        const second = add(queue, 'FAILED');
        queue.update(first.id, { output: '{"completion":{"status":"NEEDS_MORE_WORK"}}', attempts: 5 });
        queue.update(second.id, { output: '{"completion":{"status":"READY_FOR_VALIDATION"}}' });
        queue.drainVerification();
        assert.deepEqual(queue.list().map(task => [task.status, task.activityPhase]),
          [['PENDING', 'executor_recovery'], ['VERIFYING', 'decomposition_required']]);
        assert.equal(queue.claimNext().id, first.id);
      } finally { queue.close(); }
    });

    await t.test('an unfinished or crashed executor turn fails its task in both modes; an outage is retried', async () => {
      const agents = host.load('src/queue/agentExecution.ts');
      const original = agents.executeTask;
      const unfinished = async () => ({ ok: true, cutOff: false, text: 'unfinished', notes: '', stopReason: 'end_turn',
        completion: { status: 'NEEDS_MORE_WORK', summary: 'half done', filesChanged: [], developmentChecks: [] },
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } });
      const crashed = async () => { throw Error('connection lost'); };
      const outage = async () => { throw Error('cannot reach https://llm.example/v1: dial tcp 10.0.0.1:443: connectex: timeout'); };
      try {
        for (const mode of ['lockstep', 'continuous']) {
          for (const [label, run, splits] of [['unfinished', unfinished, true], ['crashed', crashed, true], ['outage', outage, false]]) {
            const queue = fresh();
            const runner = new Orchestrator(host.context, host.output, queue);
            const first = add(queue);
            add(queue);
            const executions = [];
            runner.cfg = (key, fallback) => key === 'queue.mode' ? mode : fallback;
            runner.correctTestingTarget = () => false;
            runner.wakeAfterHandoff = () => {};
            runner.schedule = () => {};
            agents.executeTask = async (_context, _output, task) => { executions.push(task.id); return run(); };
            try {
              await runner.pump();
              await runner.pump();
              const row = queue.get(first.id);
              if (splits) {
                assert.deepEqual([row.status, row.activityPhase], ['VERIFYING', 'decomposition_required'], `${mode} ${label}`);
                assert.deepEqual(executions, [first.id], `${mode} ${label}: nothing runs until the failed task is split`);
              } else {
                assert.equal(row.status, 'PENDING', `${mode} ${label}`);
                assert.deepEqual(executions, [first.id, first.id], `${mode} ${label}: an outage is simply retried`);
              }
              if (label === 'crashed') assert.match(row.errorLog, /connection lost/);
              assert.equal(queue.stats().byStatus.BLOCKED, 0);
            } finally { runner.dispose(); queue.close(); }
          }
        }
      } finally { agents.executeTask = original; }
    });

    await t.test('a silent worker has stopped working: its task waits for its split and late results are rejected', () => {
      const queue = fresh();
      const runner = new Orchestrator(host.context, host.output, queue);
      try {
        add(queue);
        const active = queue.claimNext();
        queue.db.prepare('UPDATE tasks SET last_activity_at = ? WHERE id = ?')
          .run(Date.now() - 3_600_000, active.id);
        runner.sweepSilentWorkers();
        const row = queue.get(active.id);
        assert.deepEqual([row.status, row.activityPhase], ['VERIFYING', 'decomposition_required']);
        assert.equal(queue.finishExecution(active.id, active.attempts, { status: 'VERIFIED' }), false);
        assert.equal(queue.claimNext(), undefined, 'nothing runs until the failed task is split');
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
        assert.equal(queue.runState, 'STOPPED');
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
