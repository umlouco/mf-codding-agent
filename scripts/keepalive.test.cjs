// Real queue, orchestrator and SQLite. No provider or model is involved: the
// supervisor is a keep-alive loop and execution is the final step.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('execution is terminal and the supervisor only keeps the run alive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-keepalive-'));
  const host = await createHost({ workspace: root, log() {} });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  let number = 0;
  const fresh = () => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `keepalive-${++number}.db`));
    queue.setRunState('RUNNING');
    return queue;
  };

  try {
    await t.test('a finished executor result ends the task with no verifier', async () => {
      const queue = fresh();
      queue.insert({ title: 'Task 1', description: 'Do the work.', status: 'VERIFYING' }, 1);
      queue.update(queue.list()[0].id, { output: '{"completion":{"status":"READY_FOR_VALIDATION"}}' });
      const runner = new Orchestrator(host.context, host.output, queue);
      runner.pump = async () => {};
      try {
        await runner.tick();
        assert.equal(queue.list()[0].status, 'VERIFIED');
        assert.equal(queue.runState, 'IDLE');
      } finally {
        runner.dispose();
        queue.close();
      }
    });

    await t.test('keep-alive requeues a worker left EXECUTING', async () => {
      const queue = fresh();
      queue.insert({ title: 'Task 2', description: 'Work.', status: 'EXECUTING' }, 1);
      queue.update(queue.list()[0].id, { attempts: 1 });
      assert.equal(queue.requeueStale(0), 1);
      assert.equal(queue.list()[0].status, 'PENDING');
      queue.close();
    });

    await t.test('keep-alive retries a lost worker after its attempts are spent', async () => {
      const queue = fresh();
      queue.insert({ title: 'Task 3', description: 'Work.', status: 'EXECUTING', maxAttempts: 2 }, 1);
      queue.update(queue.list()[0].id, { attempts: 2 });
      assert.equal(queue.requeueStale(0), 1);
      assert.equal(queue.list()[0].status, 'PENDING');
      queue.close();
    });

    await t.test('legacy review rows are settled, never re-verified', async () => {
      const queue = fresh();
      try {
        queue.insert({ title: 'done', description: 'x', status: 'VERIFYING' }, 1);
        queue.insert({ title: 'gone', description: 'x', status: 'VERIFYING' }, 2);
        queue.insert({ title: 'spent', description: 'x', status: 'VERIFYING', maxAttempts: 1 }, 3);
        const rows = queue.list();
        queue.update(rows[0].id, { output: '{"completion":{"status":"READY_FOR_VALIDATION"}}' });
        queue.update(rows[2].id, { attempts: 1 });
        assert.equal(queue.drainVerification(), 3);
        const [done, gone, spent] = queue.list();
        assert.equal(done.status, 'VERIFIED');
        assert.equal(gone.status, 'PENDING');
        assert.equal(spent.status, 'PENDING');
      } finally {
        queue.close();
      }
    });

    await t.test('a repair row is not settled by the legacy drain', async () => {
      const queue = fresh();
      try {
        queue.insert({ title: 'broken test', description: 'x', status: 'VERIFYING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, {
          output: 'executor result',
          supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] fixture targets the wrong host',
        });
        assert.equal(queue.drainVerification(), 0);
        assert.equal(queue.get(task.id).status, 'VERIFYING');
      } finally {
        queue.close();
      }
    });

    await t.test('an obsolete ownership stop resumes the executor, not a supervisor repair', async () => {
      const queue = fresh();
      const stop = 'Execution stopped: queue ownership: the supervisor must rewrite existing test ' +
        'internal/config/config_test.go. Report the defect and request STOP_AND_REWRITE_TESTS';
      try {
        queue.insert({ title: 'Config', description: 'Work.', status: 'PENDING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, {
          attempts: 1,
          output: stop,
          errorLog: '[attempt 1] the core stopped the turn (supervisor_repair_required): ' +
            'queue ownership: the supervisor must rewrite existing test internal/config/config_test.go.',
        });
        const runner = new Orchestrator(host.context, host.output, queue);
        runner.pump = async () => {};
        const repairs = [];
        runner.repairTests = async (t2, reason) => { repairs.push({ id: t2.id, reason }); };
        try {
          await runner.tick();
          assert.equal(repairs.length, 0);
          assert.equal(queue.get(task.id).status, 'PENDING');
          assert.match(queue.get(task.id).supervisorFeedback, /executor.*tests/i);
          assert.equal(queue.get(task.id).output, stop);
        } finally {
          runner.dispose();
        }
      } finally {
        queue.close();
      }
    });

    await t.test('a row already awaiting repair is serviced before the legacy drain', async () => {
      const queue = fresh();
      try {
        queue.insert({ title: 'Repair me', description: 'Work.', status: 'VERIFYING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, {
          output: 'executor result',
          supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] selectors are stale',
        });
        const runner = new Orchestrator(host.context, host.output, queue);
        runner.pump = async () => {};
        const repairs = [];
        runner.repairTests = async (t2, reason) => { repairs.push({ id: t2.id, reason }); };
        try {
          await runner.tick();
          assert.equal(repairs.length, 1);
          assert.match(repairs[0].reason, /selectors are stale/);
        } finally {
          runner.dispose();
        }
      } finally {
        queue.close();
      }
    });

    await t.test('the stop detail keeps the core sentence, not just the reason code', async () => {
      const { stopDetail, testOwnershipStop, TEST_OWNERSHIP_STOP } = host.load('src/queue/orchestratorState.ts');
      const stop = 'Execution stopped: queue ownership: the supervisor must rewrite existing test ' +
        'internal/config/config_test.go. Report the defect and request STOP_AND_REWRITE_TESTS';
      assert.match(stopDetail(stop), /^queue ownership:/);
      assert.match(stopDetail(stop), /config_test\.go/);
      assert.equal(TEST_OWNERSHIP_STOP.test(stopDetail(stop)), true);
      assert.equal(testOwnershipStop({
        attempts: 1, output: stop,
        errorLog: '[attempt 1] the core stopped the turn (supervisor_repair_required).',
      }), true);
      assert.equal(testOwnershipStop({ attempts: 2, output: stop,
        errorLog: '[attempt 1] the core stopped the turn (supervisor_repair_required).' }), false);
    });
  } finally {
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
