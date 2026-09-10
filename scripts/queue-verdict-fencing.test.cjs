const { assert, test, load, usage, fixture, orchestrator, report } = require('./queue-progress-helpers.cjs');

const recovery = load('src/queue/recovery.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function verifying(queue, withReport = true) {
  const task = queue.claimNext();
  queue.update(task.id, { status: 'VERIFYING', output: 'Current implementation handoff',
    validationReport: withReport ? JSON.stringify(report()) : '' });
  return queue.get(task.id);
}

test('abandoned verdict errors cannot contaminate a replacement or consume recovery budget', async t => {
  const queue = fixture(t);
  const task = verifying(queue);
  recovery.recoveryFailure(queue, task, 'verification-review');
  recovery.recoveryFailure(queue, task, 'verification-review');
  const beforeLedger = queue.getMeta(recovery.recoveryKey(task));
  const result = deferred();
  let callbacks;
  const runner = orchestrator(queue, { './agents': {
    superviseTask: (_context, _output, _task, _rewrites, _goal, options) => {
      callbacks = options;
      return result.promise;
    },
  } });
  runner.replanOrPause = () => assert.fail('An abandoned verdict must not re-plan the current task');
  const pending = runner.supervise(task);
  const replacement = { taskId: task.id, gen: ++runner.reviewGen, abort() {} };
  runner.review = replacement;
  queue.recordActivity(task.id, 'model_wait', 'Replacement review owns the task', 'supervisor');
  const before = queue.get(task.id);
  const events = queue.events(task.id, -1).length;
  callbacks.onActivity({ phase: 'error', detail: 'Stale activity', at: Date.now() });
  callbacks.onEvent('stream/tool', { id: 'late', name: 'read_file', status: 'ok', output: 'Old content' });
  let stopped = 0;
  callbacks.onAbort(() => stopped++);
  result.reject(new Error('The abandoned core finally exited'));
  await pending;
  assert.equal(stopped, 1, 'Late startup is cancelled rather than taking the replacement abort handle');
  assert.equal(runner.review, replacement);
  assert.deepEqual(queue.get(task.id), before);
  assert.equal(queue.events(task.id, -1).length, events);
  assert.equal(queue.getMeta(recovery.recoveryKey(task)), beforeLedger);
});

const changedSnapshots = [
  ['status', 'PENDING'], ['startedAt', 987654321], ['attempts', 17], ['seq', 18],
  ['description', 'New owner requirements'], ['implVerifyPrompt', 'New implementation criterion'],
  ['solutionVerifyPrompt', 'New behavior criterion'], ['solutionVerifyCommand', 'new-required-check'],
  ['region', '{"owner":"changed scope"}'], ['validationReport', 'Replacement verification report'],
];

test('late verdicts and errors cannot act on a task edited without changing the review generation', async t => {
  for (const outcome of ['VERIFIED', 'RETRY', 'error']) {
    for (const [field, value] of changedSnapshots) {
      const queue = fixture(t);
      const task = verifying(queue);
      const result = deferred();
      let callbacks;
      const runner = orchestrator(queue, { './agents': {
        superviseTask: (_context, _output, _task, _rewrites, _goal, options) => {
          callbacks = options;
          return result.promise;
        },
      } });
      const pending = runner.supervise(task);
      queue.update(task.id, { [field]: value });
      const before = queue.get(task.id);
      const events = queue.events(task.id, -1).length;
      const ledger = queue.getMeta(recovery.recoveryKey(task));
      callbacks.onActivity({ phase: 'tool', detail: 'Stale observation', at: Date.now() });
      callbacks.onEvent('stream/tool', { id: 'late', name: 'read_file', status: 'ok', output: 'Old content' });
      if (outcome === 'error') result.reject(new Error('Old request failed'));
      else result.resolve({ verdict: outcome, feedback: 'Old decision', usage,
        taskEdits: [{ seq: task.seq, description: 'Stale rewritten task' }] });
      await pending;
      assert.deepEqual(queue.get(task.id), before, `${outcome} must preserve changed ${field}`);
      assert.equal(queue.events(task.id, -1).length, events);
      assert.equal(queue.getMeta(recovery.recoveryKey(task)), ledger);
    }
  }
});

test('late validator callbacks, reports and errors remain fenced to their exact task snapshot', async t => {
  for (const outcome of ['report', 'error']) {
    for (const [field, value] of [...changedSnapshots, ['generation', 42]]) {
      const queue = fixture(t);
      const task = verifying(queue, false);
      const result = deferred();
      const started = deferred();
      let callbacks;
      const runner = orchestrator(queue, { './verification': {
        runVerification: (_context, _output, _task, _goal, onActivity, onEvent, onAbort) => {
          callbacks = { onActivity, onEvent, onAbort };
          started.resolve();
          return result.promise;
        },
      } });
      const review = { taskId: task.id, seq: task.seq, gen: ++runner.reviewGen, lastActivityAt: Date.now() };
      runner.review = review;
      const pending = runner.verifyWithExecutor(task, review);
      await started.promise;
      if (field === 'generation') runner.reviewGen = value;
      else queue.update(task.id, { [field]: value });
      const before = queue.get(task.id);
      const events = queue.events(task.id, -1).length;
      callbacks.onActivity({ phase: 'tool', detail: 'Stale validator heartbeat', at: Date.now() });
      callbacks.onEvent('stream/tool', { id: 'late', name: 'browser_eval', status: 'ok', output: 'Old PASS' });
      let stopped = 0;
      callbacks.onAbort(() => stopped++);
      if (outcome === 'error') result.reject(new Error('Old validator failed'));
      else result.resolve({ text: 'Old validation', validationReport: JSON.stringify(report()), usage });
      await pending;
      assert.equal(stopped, 1);
      assert.deepEqual(queue.get(task.id), before, `${outcome} must preserve changed ${field}`);
      assert.equal(queue.events(task.id, -1).length, events);
    }
  }
});

test('a stale task snapshot cannot launch validation or consume its retry budget', async t => {
  const queue = fixture(t);
  const task = verifying(queue, false);
  const runner = orchestrator(queue, { './verification': {
    runVerification: () => assert.fail('Do not launch a stale validator'),
  } });
  const review = { taskId: task.id, seq: task.seq, gen: ++runner.reviewGen, lastActivityAt: Date.now() };
  queue.update(task.id, { solutionVerifyPrompt: 'Owner changed the required check' });
  await runner.verifyWithExecutor(task, review);
  assert.equal(queue.get(task.id).validationReport, '');
  assert.equal(queue.countEvents(task.id, 'verification-pass'), 0);
});

test('a split verdict requests planner decomposition instead of a legacy preflight', async t => {
  const queue = fixture(t);
  const task = verifying(queue);
  let replans = 0;
  const runner = orchestrator(queue, { './agents': {
    superviseTask: async () => ({ verdict: 'SPLIT', feedback: 'Investigate independent work', usage }),
  } });
  runner.scopeWatch = () => assert.fail('The legacy split path must not start its own preflight');
  runner.requestFailureDecomposition = (snapshot, reason) => {
    replans++;
    assert.equal(snapshot.id, task.id);
    assert.equal(reason, 'Investigate independent work');
  };
  await runner.supervise(task);
  assert.equal(replans, 1);
  assert.equal(queue.get(task.id).validationReport, task.validationReport);
});
