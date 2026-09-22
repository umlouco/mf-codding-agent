// The run circuit breaker, against a real queue and real SQLite. No provider
// is involved: every case here is decided by the durable token counters.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

const LIMIT = 50_000_000;

test('the run breaker subdivides the work instead of stopping the run', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-breaker-'));
  const host = await createHost({
    workspace: root,
    log() {},
    settings: { 'queue.maxRunTokens': LIMIT, 'queue.maxRunMinutes': 0, 'queue.maxRunTasks': 0 },
  });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');

  let number = 0;
  // Each case gets its own database, orchestrator and stubbed pump: start()
  // arms a cron and a watchdog, and only dispose() takes them back down.
  const fresh = (usage) => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `breaker-${++number}.db`));
    queue.insert({ title: `Task ${number}`, description: 'Work.' }, 1);
    if (usage) queue.addUsage(queue.list()[0].id, usage);
    const runner = new Orchestrator(host.context, host.output, queue);
    runner.pump = async () => {};
    return { queue, runner };
  };

  try {
    await t.test('a queue already over the limit can still be started', async () => {
      // The failure this guards: the counters are durable and only grow, so a
      // breaker reading the totals stopped the run in the same second Start
      // set it RUNNING, leaving the queue permanently unstartable.
      const { queue, runner } = fresh({ input: 60_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
      try {
        runner.start();
        assert.equal(queue.runState, 'RUNNING');
        assert.equal(runner.runBreakerTripped(), false);
        assert.equal(queue.runState, 'RUNNING');
      } finally {
        runner.dispose();
        queue.close();
      }
    });

    await t.test('re-sent cached context is not spend', async () => {
      // 80 rounds of one task re-sending the same cached prompt: the raw
      // prompt_tokens sum is over the limit, the fresh input is 2M.
      const { queue, runner } = fresh();
      try {
        runner.start();
        queue.addUsage(queue.list()[0].id, {
          input: 60_000_000, output: 100_000, cacheRead: 58_000_000, cacheWrite: 0,
        });
        assert.equal(runner.runBreakerTripped(), false);
        assert.equal(queue.runState, 'RUNNING');
      } finally {
        runner.dispose();
        queue.close();
      }
    });

    await t.test('overspending splits the task in flight and keeps the run alive', async () => {
      const { queue, runner } = fresh();
      try {
        runner.start();
        const id = queue.list()[0].id;
        queue.update(id, { status: 'EXECUTING' });
        let replaced = null;
        runner.requestFailureDecomposition = (task, reason) => { replaced = { task, reason }; };
        queue.addUsage(id, { input: LIMIT + 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });

        assert.equal(runner.runBreakerTripped(), true);
        // The whole point: the queue keeps running and the work is subdivided.
        assert.equal(queue.runState, 'RUNNING');
        assert.ok(replaced, 'the task in flight is handed to decomposition');
        assert.equal(replaced.task.id, id);
        assert.match(replaced.reason, /Replace this task with smaller tasks/);
        const tripped = queue.events(null, 50).find(e => e.kind === 'breaker');
        assert.ok(tripped, 'the trip is recorded in the journal');
        assert.match(tripped.message, /tokens, over the/);
      } finally {
        runner.dispose();
        queue.close();
      }
    });

    await t.test('a trip opens a fresh window, so it cannot fire on a loop', async () => {
      const { queue, runner } = fresh();
      try {
        runner.start();
        const id = queue.list()[0].id;
        queue.update(id, { status: 'EXECUTING' });
        let splits = 0;
        runner.requestFailureDecomposition = () => { splits++; };
        queue.addUsage(id, { input: LIMIT + 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });

        assert.equal(runner.runBreakerTripped(), true);
        assert.equal(splits, 1);
        // Same durable counters, next pump: the window moved with the trip.
        assert.equal(runner.runBreakerTripped(), false);
        assert.equal(splits, 1);
        assert.equal(queue.runState, 'RUNNING');
      } finally {
        runner.dispose();
        queue.close();
      }
    });

    await t.test('a row-count runaway is not answered by adding more rows', async () => {
      const { queue, runner } = fresh();
      try {
        runner.start();
        const id = queue.list()[0].id;
        queue.update(id, { status: 'EXECUTING' });
        let splits = 0;
        runner.requestFailureDecomposition = () => { splits++; };
        // One row over a limit of one added row.
        runner.cfg = (key, fallback) =>
          key === 'queue.maxRunTasks' ? 1 : key === 'queue.maxRunTokens' ? 0 :
          key === 'queue.maxRunMinutes' ? 0 : fallback;
        queue.insert({ title: 'Extra 1', description: 'x' }, 2);
        queue.insert({ title: 'Extra 2', description: 'x' }, 3);

        assert.equal(runner.runBreakerTripped(), true);
        assert.equal(splits, 0, 'decomposing here would multiply the rows that tripped it');
        assert.equal(queue.runState, 'RUNNING');
      } finally {
        runner.dispose();
        queue.close();
      }
    });

    await t.test('a reload mid-run keeps the origin it was given', async () => {
      // Activation calls start() for a queue that was already RUNNING. That is
      // the same run, so its budget must not quietly reset on every reload.
      const { queue, runner } = fresh();
      try {
        runner.start();
        const baseline = queue.getMeta('runTokenBaseline');
        const startedAt = queue.getMeta('runStartedAt');
        queue.addUsage(queue.list()[0].id, { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0 });
        runner.start();
        assert.equal(queue.getMeta('runTokenBaseline'), baseline);
        assert.equal(queue.getMeta('runStartedAt'), startedAt);
      } finally {
        runner.dispose();
        queue.close();
      }
    });
  } finally {
    await host.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
