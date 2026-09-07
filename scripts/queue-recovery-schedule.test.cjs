const { fs, os, path, assert, test, load, TaskQueue, fixture } = require('./queue-progress-helpers.cjs');
const schedule = load('src/queue/recoverySchedule.ts');
const recovery = load('src/queue/recovery.ts');
const plain = value => JSON.parse(JSON.stringify(value));

test('scheduled failures, attempted strategies and next deadline survive closing and reopening the real database', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-recovery-schedule-'));
  const file = path.join(dir, 'queue.sqlite');
  let queue = TaskQueue.open(file);
  t.after(() => {
    queue.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('mf-recovery-schedule-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  queue.replaceAll([{ title: 'One outcome', description: 'Preserve the acceptance criteria.' }]);
  queue.setRunState('RUNNING');
  const task = queue.claimNext();
  schedule.scheduleRecoveryJob(queue, task, 'Find a corrected invocation.');
  schedule.beginRecoveryAttempt(queue, task);
  const fingerprint = schedule.recoveryStrategyFingerprint({ command: 'node check.cjs', cwd: 'web' });
  assert.equal(schedule.rememberRecoveryStrategy(queue, task, fingerprint), true);
  schedule.deferRecoveryJob(queue, task, 'Still unavailable.', 60_000);
  const before = plain(schedule.readRecoveryJob(queue, task));
  queue.close();
  queue = TaskQueue.open(file);
  assert.deepEqual(plain(schedule.readRecoveryJob(queue, queue.get(task.id))), before);
  assert.equal(schedule.beginRecoveryAttempt(queue, task), undefined);
  assert.equal(schedule.rememberRecoveryStrategy(queue, task, fingerprint), false);
  assert.deepEqual(plain(schedule.scheduleRecoveryJob(queue, task, 'A restart is not progress.')), before);
  assert.equal(queue.runState, 'RUNNING');
});

test('beginning recovery persists a retry reservation before an asynchronous operation can fail or crash', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  schedule.scheduleRecoveryJob(queue, task, 'Bounded diagnosis.');
  const first = schedule.beginRecoveryAttempt(queue, task);
  assert.equal(first.attempts, 1);
  assert.ok(first.dueAt > Date.now());
  assert.equal(schedule.beginRecoveryAttempt(queue, task), undefined);
  assert.equal(schedule.readRecoveryJob(queue, task).attempts, 1);
  assert.equal(queue.get(task.id).attempts, task.attempts, 'a diagnostic is not an executor retry');
});

test('admitting a changed strategy acknowledges old repetition without erasing cumulative history', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  const observation = () => queue.log(task.id, 'executor', 'tool', 'read_file(path) -> ok\nunchanged outcome');
  observation();
  recovery.recoveryEvidence(queue, task);
  for (let i = 0; i < 6; i++) observation();
  for (let i = 0; i < 6; i++) recovery.recoveryRequest(queue, task);
  const before = plain(recovery.recoveryEvidence(queue, task));
  assert.match(recovery.recoveryReplayLimit(before), /Six repeated/);
  recovery.acknowledgeRecovery(queue, task);
  const after = recovery.recoveryEvidence(queue, task);
  assert.equal(after.recoveries, before.recoveries);
  assert.equal(after.repeats, before.repeats);
  assert.deepEqual(plain(after.seen), before.seen);
  assert.equal(recovery.recoveryReplayLimit(after), '');
  for (let i = 0; i < 6; i++) observation();
  assert.match(recovery.recoveryReplayLimit(recovery.recoveryEvidence(queue, task)), /Six repeated/);
  assert.equal(recovery.recoveryRequest(queue, task), '');
  assert.equal(recovery.recoveryRequest(queue, task), '');
  assert.match(recovery.recoveryRequest(queue, task), /Three recovery requests/);
});

test('a fractional or unbounded requested wait cannot corrupt durable scheduling or renew it', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  schedule.scheduleRecoveryJob(queue, task, 'Wait for a dependency.');
  schedule.beginRecoveryAttempt(queue, task);
  const job = schedule.deferRecoveryJob(queue, task, 'Wait.', 10_000.75);
  assert.ok(Number.isSafeInteger(job.dueAt));
  assert.equal(schedule.readRecoveryJob(queue, task).attempts, 1);
  const later = schedule.deferRecoveryJob(queue, task, 'No infinite timestamp.', Infinity);
  assert.ok(Number.isSafeInteger(later.dueAt));
  assert.equal(schedule.readRecoveryJob(queue, task).attempts, 1);
});
