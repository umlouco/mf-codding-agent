const { test } = require('node:test');
const { assert, fixture, drain } = require('./queue-scope-helpers.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
function setup(t, executeTask = async () => { throw Error('Unchanged execution must not launch.'); }) {
  const f = fixture(t, { executeTask }, { './verificationPlanRunner': {} });
  const task = f.queue.claimNext();
  f.queue.update(task.id, { kind: 'phase', status: 'VERIFYING', output: 'Preserved implementation handoff.',
    validationReport: 'Unsuccessful but useful independent evidence.', errorLog: 'Failure history.', attempts: 3 });
  f.schedule = f.load('src/queue/recoverySchedule.ts');
  f.recovery = f.load('src/queue/recovery.ts');
  f.task = f.queue.get(task.id);
  f.runner.reviewWork = async () => assert.fail('Ordinary review must not bypass scheduled recovery.');
  f.runner.supervise = async () => assert.fail('An old report must not bypass scheduled recovery.');
  t.after(() => { f.runner.disposed = true; f.runner.disarm(); clearInterval(f.runner.watchdog); });
  return f;
}
function later(f, delay = 60_000) {
  const job = f.schedule.readRecoveryJob(f.queue, f.task);
  job.dueAt = Date.now() + delay;
  f.queue.setMeta(f.schedule.recoveryJobKey(f.task), JSON.stringify(job));
  return job;
}

test('phase recovery: exhausting ordinary retries schedules focused recovery without automatically pausing the queue', async t => {
  const f = setup(t);
  assert.equal(await f.runner.allowRecovery(f.task, 'REVERIFY'), true);
  assert.equal(await f.runner.allowRecovery(f.task, 'REVERIFY'), true);
  assert.equal(await f.runner.allowRecovery(f.task, 'REVERIFY'), false);
  assert.equal(f.queue.runState, 'RUNNING');
  const after = f.queue.get(f.task.id);
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'validationReport', 'errorLog', 'attempts']) assert.equal(after[field], f.task[field], field);
  assert.equal(after.status, 'VERIFYING');
  assert.equal(after.activityPhase, 'recovery_waiting');
  assert.equal(f.recovery.recoveryState(f.queue, after).recoveries, 3);
  assert.equal(f.schedule.readRecoveryJob(f.queue, after).active, true);
});

test('phase recovery: tick and Check now gate both review lanes with zero model calls before durable dueAt', async t => {
  const f = setup(t);
  let calls = 0;
  f.runner.performRecovery = async () => { calls++; return { status: 'deferred', reason: 'Dependency remains unavailable.' }; };
  f.runner.pauseForRecovery(f.task, 'Do not rerun the same unsuccessful command.');
  const job = later(f);
  for (let i = 0; i < 4; i++) await f.runner.runNow();
  f.runner.kick();
  await drain();
  assert.equal(calls, 0);
  assert.equal(f.queue.runState, 'RUNNING');
  assert.deepEqual(plain(f.schedule.readRecoveryJob(f.queue, f.task)), plain(job));
  assert.equal(f.queue.get(f.task.id).validationReport, f.task.validationReport);
});

test('phase recovery: failed autonomous attempts persist bounded exponential backoff and continue running', async t => {
  const f = setup(t);
  let calls = 0;
  f.runner.performRecovery = async () => { calls++; throw Error('Recovery provider unavailable.'); };
  f.runner.pauseForRecovery(f.task, 'Diagnose unavailable tooling.');
  await f.runner.runNow();
  const first = f.schedule.readRecoveryJob(f.queue, f.task);
  assert.equal(calls, 1);
  assert.equal(first.attempts, 1);
  assert.ok(first.dueAt >= first.updatedAt + 4500);
  assert.match(first.lastError, /provider unavailable/);
  await f.runner.runNow();
  assert.equal(calls, 1, 'the next cron tick cannot immediately spend more tokens');
  later(f, -1);
  await f.runner.runNow();
  const second = f.schedule.readRecoveryJob(f.queue, f.task);
  assert.equal(second.attempts, 2);
  assert.ok(second.dueAt >= second.updatedAt + 9500);
  assert.equal(f.schedule.recoveryBackoff(10000), 300_000);
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
});

test('phase recovery: an admitted changed strategy resumes the real execution pump without erasing failed strategy history', async t => {
  let executions = 0;
  const f = setup(t, async () => { executions++; return new Promise(() => {}); });
  f.runner.scopeWatch = () => ({ preflight: async () => true, observe() {}, close() {} });
  f.runner.pauseForRecovery(f.task, 'Use a different bounded repair.');
  const fingerprint = f.schedule.recoveryStrategyFingerprint('inspect command argument handling');
  f.runner.performRecovery = async task => {
    assert.equal(f.schedule.rememberRecoveryStrategy(f.queue, task, fingerprint), true);
    f.queue.update(task.id, { kind: 'task', status: 'PENDING', supervisorFeedback: 'Correct argument handling; retain all acceptance criteria.' });
    return { status: 'applied' };
  };
  await f.runner.runNow();
  await drain();
  assert.equal(executions, 1);
  assert.equal(f.queue.get(f.task.id).status, 'EXECUTING');
  assert.equal(f.queue.get(f.task.id).attempts, 4);
  assert.equal(f.queue.get(f.task.id).output, f.task.output);
  const job = f.schedule.readRecoveryJob(f.queue, f.task);
  assert.equal(job.active, false);
  assert.equal(job.attempts, 1);
  assert.deepEqual(plain(job.failedStrategies), [fingerprint]);
  assert.equal(f.schedule.rememberRecoveryStrategy(f.queue, f.task, fingerprint), false);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('phase recovery: user Stop and Pause fence in-flight recovery and never get overridden by its late result', async t => {
  for (const control of ['stop', 'pause']) {
    const f = setup(t);
    let settle;
    f.runner.performRecovery = async () => new Promise(resolve => { settle = resolve; });
    f.runner.pauseForRecovery(f.task, 'Await a bounded diagnostic.');
    const pending = f.runner.runNow();
    await drain();
    assert.equal(typeof settle, 'function');
    f.runner[control]();
    settle({ status: 'applied' });
    await pending;
    assert.equal(f.queue.runState, control === 'stop' ? 'STOPPED' : 'PAUSED');
    assert.equal(f.schedule.readRecoveryJob(f.queue, f.task).active, true);
    assert.equal(f.queue.get(f.task.id).validationReport, f.task.validationReport);
  }
});

test('phase recovery: owner edits during recovery cannot receive stale failure activity or erased retry history', async t => {
  const f = setup(t);
  let settle;
  f.runner.performRecovery = async () => new Promise(resolve => { settle = resolve; });
  f.runner.pauseForRecovery(f.task, 'Diagnose an old contract.');
  const pending = f.runner.runNow();
  await drain();
  f.queue.update(f.task.id, { description: 'Owner supplied a revised outcome.',
    activityPhase: 'operator_edited', activityDetail: 'New owner instructions.' });
  settle({ status: 'deferred', reason: 'Stale failure diagnosis.' });
  await pending;
  assert.equal(f.queue.get(f.task.id).activityPhase, 'operator_edited');
  assert.equal(f.schedule.readRecoveryJob(f.queue, f.task).attempts, 1);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('phase recovery: outstanding scheduled recovery prevents a false finished transition', t => {
  const f = setup(t);
  f.runner.pauseForRecovery(f.task, 'Unresolved work remains.');
  for (const task of f.queue.list()) f.queue.update(task.id, { status: 'VERIFIED' });
  f.runner.finish();
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.schedule.hasOutstandingRecovery(f.queue), true);
});

test('phase recovery: only explicit Reset clears durable jobs and their strategy history', t => {
  const f = setup(t);
  f.runner.pauseForRecovery(f.task, 'Unresolved work remains.');
  f.schedule.rememberRecoveryStrategy(f.queue, f.task, 'failed-invocation');
  f.runner.reset();
  assert.equal(f.schedule.readRecoveryJob(f.queue, f.task), undefined);
  assert.equal(f.queue.runState, 'IDLE');
});
