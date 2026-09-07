const { test } = require('node:test');
const { assert, fixture, drain } = require('./queue-scope-helpers.cjs');

function blockedQueue(t, status = 'VERIFYING', runState = 'PAUSED') {
  let executions = 0, reviews = 0;
  const f = fixture(t, { executeTask: async () => { executions++; return new Promise(() => {}); } }, {
    './monitor': { JOURNAL_EVENTS: 80, VALIDATION_FAILED: 'validation-failed',
      reviewProgress: async () => { reviews++; return { action: 'CONTINUE_EXECUTION', reason: 'Resume preserved work.',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; } },
  });
  const task = f.queue.list()[0];
  f.queue.update(task.id, { status, attempts: 3, output: 'Retain implemented work.',
    validationReport: '', errorLog: 'Retain failure evidence.', supervisorFeedback: 'Existing report.',
    activityPhase: 'recovery_blocked', activityDetail: 'Blocked before Start.' });
  const recovery = f.load('src/queue/recovery.ts');
  f.queue.log(task.id, 'executor', 'tool', 'read_file(a) → ok\nunchanged');
  const state = recovery.recoveryEvidence(f.queue, f.queue.get(task.id));
  Object.assign(state, { repeats: 39, recoveries: 6, unchanged: 3, failures: { 'progress-review': 3 } });
  recovery.saveRecovery(f.queue, f.queue.get(task.id), state);
  recovery.blockRecovery(f.queue, f.queue.get(task.id), 'Repeated old outcomes.');
  f.queue.setRunState(runState);
  f.runner.scopeWatch = () => ({ preflight: async () => true, observe() {}, close() {} });
  // Stop actual timers after each case; retain the actual public Start path.
  t.after(() => { f.runner.disposed = true; f.runner.disarm(); clearInterval(f.runner.watchdog); });
  return { ...f, task: f.queue.get(task.id), recovery, executions: () => executions, reviews: () => reviews };
}

test('Start releases a paused recovery latch and reaches a worker without resetting tasks', async t => {
  const f = blockedQueue(t, 'PAUSED');
  f.runner.start();
  await drain();
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.executions(), 1);
  const after = f.queue.get(f.task.id);
  assert.equal(after.status, 'EXECUTING');
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'validationReport', 'errorLog']) assert.equal(after[field], f.task[field], field);
  assert.equal(after.attempts, 4, 'Start does not erase the task attempt history');
  const state = f.recovery.recoveryState(f.queue, after);
  assert.equal(state.blocked, undefined);
  assert.equal(state.repeats, 0);
  assert.equal(state.recoveries, 0);
  assert.equal(f.queue.countEvents(after.id, 'recovery-resumed'), 1);
});

test('the reported VERIFYING state reaches supervision instead of re-pausing one second after Start', async t => {
  const f = blockedQueue(t);
  f.runner.start();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.reviews(), 1, 'actual progress review must reach the provider, not just a mocked reviewWork method');
  assert.equal(f.executions(), 1, 'actual tick hands preserved work back to an executor');
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.get(f.task.id).status, 'EXECUTING');
  assert.equal(f.queue.get(f.task.id).output, f.task.output);
});

test('automatic RUNNING restoration and repeated Start while already running do not renew recovery', async t => {
  const f = blockedQueue(t, 'VERIFYING', 'RUNNING');
  f.runner.start();
  f.runner.start();
  assert.match(f.recovery.recoveryState(f.queue, f.task).blocked, /Repeated/);
  assert.equal(f.queue.countEvents(f.task.id, 'recovery-resumed'), 0);
});

test('explicit restart preserves and archives recovery history while new failed retries remain bounded', async t => {
  const f = blockedQueue(t, 'VERIFYING', 'STOPPED');
  f.runner.start();
  const task = f.queue.get(f.task.id);
  const event = f.queue.events(task.id, -1).find(e => e.kind === 'recovery-resumed');
  assert.ok(event);
  const archiveKey = JSON.parse(event.message).archiveKey;
  const archived = JSON.parse(f.queue.getMeta(archiveKey));
  assert.equal(archived.repeats, 39);
  assert.equal(archived.recoveries, 6);
  assert.equal(archived.failures['progress-review'], 3);
  assert.match(archived.blocked, /Repeated/);
  assert.equal(f.recovery.recoveryRequest(f.queue, task), '');
  assert.equal(f.recovery.recoveryRequest(f.queue, task), '');
  assert.match(f.recovery.recoveryRequest(f.queue, task), /Three recovery/);
  assert.equal(f.queue.get(task.id).description, f.task.description);
});

test('Start skips old unread tool events rather than immediately reconstructing the previous block', async t => {
  const f = blockedQueue(t);
  for (let i = 0; i < 20; i++) f.queue.log(f.task.id, 'executor', 'tool', 'read_file(a) → ok\nunchanged');
  const watermark = f.queue.latestWorkerToolEventId(f.task.id);
  f.runner.start();
  const state = f.recovery.recoveryEvidence(f.queue, f.task);
  assert.equal(state.cursor, watermark);
  assert.equal(state.repeats, 0);
  assert.equal(state.blocked, undefined);
});
