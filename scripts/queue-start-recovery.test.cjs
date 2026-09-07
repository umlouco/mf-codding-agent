const { test } = require('node:test');
const { assert, fixture, drain } = require('./queue-scope-helpers.cjs');

function blockedQueue(t, status = 'VERIFYING', runState = 'PAUSED') {
  let executions = 0, recoveries = 0;
  const f = fixture(t, { executeTask: async () => { executions++; return new Promise(() => {}); } }, { './verificationPlanRunner': {} });
  const task = f.queue.list()[0];
  f.queue.update(task.id, { status, attempts: 3, output: 'Retain implemented work.',
    validationReport: 'Retain previous independent evidence.', errorLog: 'Retain failure evidence.',
    supervisorFeedback: 'Existing report.', activityPhase: 'recovery_blocked', activityDetail: 'Blocked before Start.' });
  const recovery = f.load('src/queue/recovery.ts');
  const schedule = f.load('src/queue/recoverySchedule.ts');
  f.queue.log(task.id, 'executor', 'tool', 'read_file(a) -> ok\nunchanged');
  const state = recovery.recoveryEvidence(f.queue, f.queue.get(task.id));
  Object.assign(state, { repeats: 39, recoveries: 6, unchanged: 3, failures: { 'progress-review': 3 } });
  recovery.saveRecovery(f.queue, f.queue.get(task.id), state);
  recovery.blockRecovery(f.queue, f.queue.get(task.id), 'Repeated old outcomes.');
  f.queue.setRunState(runState);
  f.runner.scopeWatch = () => ({ preflight: async () => true, observe() {}, close() {} });
  f.runner.performRecovery = async () => { recoveries++; return { status: 'deferred', reason: 'A changed strategy needs evidence.' }; };
  f.runner.reviewWork = async () => assert.fail('Ordinary review cannot bypass recovery.');
  f.runner.supervise = async () => assert.fail('An old report cannot bypass recovery.');
  t.after(() => { f.runner.disposed = true; f.runner.disarm(); clearInterval(f.runner.watchdog); });
  return { ...f, task: f.queue.get(task.id), recovery, schedule, executions: () => executions, recoveries: () => recoveries };
}

test('Start migrates a legacy paused recovery into autonomous work without resetting tasks or counters', async t => {
  const f = blockedQueue(t, 'PAUSED');
  f.runner.start();
  await drain();
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.executions(), 0, 'Start must not relaunch the exhausted unchanged strategy');
  const after = f.queue.get(f.task.id);
  assert.equal(after.status, 'VERIFYING');
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'validationReport', 'errorLog', 'attempts']) assert.equal(after[field], f.task[field], field);
  const state = f.recovery.recoveryState(f.queue, after);
  assert.equal(state.repeats, 39);
  assert.equal(state.recoveries, 6);
  assert.equal(f.schedule.readRecoveryJob(f.queue, after).active, true);
  assert.equal(f.queue.countEvents(after.id, 'recovery-resumed'), 1);
});

test('the reported VERIFYING state reaches scheduled recovery and stays RUNNING after the real Start timer', async t => {
  const f = blockedQueue(t);
  f.runner.start();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.recoveries(), 1, 'actual Start/tick must reach the autonomous recovery lane');
  assert.equal(f.executions(), 0);
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
  assert.equal(f.queue.get(f.task.id).output, f.task.output);
  assert.ok(f.schedule.readRecoveryJob(f.queue, f.task).dueAt > Date.now());
});

test('automatic RUNNING restoration and repeated Start preserve future deadlines and failed strategies', async t => {
  const f = blockedQueue(t, 'VERIFYING', 'RUNNING');
  f.schedule.scheduleRecoveryJob(f.queue, f.task, 'Existing recovery job.');
  f.schedule.rememberRecoveryStrategy(f.queue, f.task, 'failed-strategy-fingerprint');
  f.schedule.deferRecoveryJob(f.queue, f.task, 'Wait for a useful diagnostic.', 60_000);
  const before = JSON.stringify(f.schedule.readRecoveryJob(f.queue, f.task));
  f.runner.start();
  f.runner.start();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.recoveries(), 0);
  assert.equal(JSON.stringify(f.schedule.readRecoveryJob(f.queue, f.task)), before);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('explicit Stop then Start does not reset a durable recovery job or its failure budget', async t => {
  const f = blockedQueue(t, 'VERIFYING', 'STOPPED');
  f.schedule.scheduleRecoveryJob(f.queue, f.task, 'Existing recovery job.');
  f.schedule.rememberRecoveryStrategy(f.queue, f.task, 'failed-strategy');
  f.schedule.beginRecoveryAttempt(f.queue, f.task);
  f.schedule.deferRecoveryJob(f.queue, f.task, 'Recovery provider is unavailable.', 60_000);
  const before = JSON.stringify(f.schedule.readRecoveryJob(f.queue, f.task));
  f.runner.start();
  await f.runner.runNow();
  assert.equal(f.recoveries(), 0);
  assert.equal(JSON.stringify(f.schedule.readRecoveryJob(f.queue, f.task)), before);
  assert.equal(f.recovery.recoveryState(f.queue, f.task).recoveries, 6);
  assert.equal(f.queue.get(f.task.id).description, f.task.description);
});

test('Start retains unread replay evidence rather than laundering it into a fresh budget', async t => {
  const f = blockedQueue(t);
  for (let i = 0; i < 20; i++) f.queue.log(f.task.id, 'executor', 'tool', 'read_file(a) -> ok\nunchanged');
  const watermark = f.queue.latestWorkerToolEventId(f.task.id);
  f.runner.start();
  const state = f.recovery.recoveryEvidence(f.queue, f.task);
  assert.equal(state.cursor, watermark);
  assert.equal(state.repeats, 59);
  assert.equal(state.recoveries, 6);
  assert.equal(f.schedule.readRecoveryJob(f.queue, f.task).active, true);
});
