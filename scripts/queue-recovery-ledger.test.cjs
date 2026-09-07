const {
  fs, os, path, assert, test, load, TaskQueue, fixture, orchestrator, usage,
} = require('./queue-progress-helpers.cjs');

const recovery = load('src/queue/recovery.ts');
const { formatToolEvent } = load('src/queue/orchestratorState.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const completed = (queue, task, output = 'unchanged contents', elapsed = 1, actor = 'executor') => {
  queue.log(task.id, actor, 'tool', formatToolEvent('read_file', { path: 'src/handler.ts' }, 'ok', output, elapsed));
};

function runnerFor(queue, overrides = {}) {
  return orchestrator(queue, { './scopeSupervisor': {},
    './agents': { attemptsExhausted: task => task.attempts >= task.maxAttempts }, ...overrides });
}

function scopeCounter(runner, result = async () => true) {
  const counts = { calls: 0, closed: 0 };
  runner.scopeWatch = () => ({
    preflight: async () => { counts.calls++; return result(); },
    close: () => { counts.closed++; },
  });
  return counts;
}

test('completed outcome novelty ignores elapsed time, thinking, heartbeats and replayed reads', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  completed(queue, task);
  const first = recovery.recoveryEvidence(queue, task);
  assert.ok(first.revision > 0);
  completed(queue, task, 'unchanged contents', 987.5);
  queue.log(task.id, 'executor', 'reasoning', 'I am still working.');
  queue.log(task.id, 'executor', 'activity:working', 'The model is alive.');
  queue.log(task.id, 'supervisor', 'tool', 'Another supervisor inspection.');
  queue.log(task.id, 'executor', 'tool', 'read_file() \u2192 start');
  const replay = recovery.recoveryEvidence(queue, task);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.repeats, 1);
  assert.equal(recovery.decisionEvidence(queue, task), first.revision);
  assert.equal(recovery.recoveryEvidence(queue, task).repeats, 1, 'consumed journal rows are not counted twice');
  completed(queue, task, 'actual new contents');
  const changed = recovery.recoveryEvidence(queue, task);
  assert.ok(changed.revision > replay.revision);
  assert.equal(changed.repeats, 0);
  assert.notEqual(queue.get(task.id).status, 'VERIFIED', 'novel observations are not acceptance evidence');
});

test('a duplicate completed read cannot invalidate a pending intervention', async t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  completed(queue, task);
  const evidenceEventId = recovery.decisionEvidence(queue, task);
  completed(queue, task, 'unchanged contents', 300);
  const runner = runnerFor(queue);
  await runner.applyProgressDecision(task, {
    action: 'STOP_AND_REWRITE_TASK', reason: 'Use a bounded next experiment.',
    rewrittenDescription: 'Correct the handler, then check the one failing transition.',
  }, { evidenceEventId });
  assert.equal(queue.get(task.id).status, 'PENDING');
  assert.match(queue.get(task.id).description, /bounded|one failing transition/);
  assert.equal(queue.countEvents(task.id, 'review-outdated'), 0);
});

test('new completed outcomes and new mutating tool starts still fence older reviews', async t => {
  for (const novel of ['outcome', 'mutation']) {
    const queue = fixture(t);
    const task = queue.claimNext();
    completed(queue, task);
    const evidenceEventId = recovery.decisionEvidence(queue, task);
    if (novel === 'outcome') completed(queue, task, 'changed contents');
    else queue.log(task.id, 'executor', 'tool', 'write_file() \u2192 start');
    const runner = runnerFor(queue);
    await runner.applyProgressDecision(task, {
      action: 'STOP_AND_REWRITE_TASK', reason: 'This decision used older evidence.',
      rewrittenDescription: 'Must not overwrite the active approach.',
    }, { evidenceEventId });
    assert.equal(queue.get(task.id).status, 'EXECUTING');
    assert.equal(queue.get(task.id).description, task.description);
    assert.equal(queue.countEvents(task.id, 'review-outdated'), 1);
  }
});

test('three no-evidence recoveries cause one scope re-plan, then preserve work and pause durably', async t => {
  const queue = fixture(t);
  const original = queue.claimNext();
  queue.update(original.id, { output: 'Implementation remains in the working tree.',
    validationReport: 'The first transition has passed; the second remains unchecked.' });
  const task = queue.get(original.id);
  const runner = runnerFor(queue);
  let cancelled = 0;
  runner.executionAbort = () => { cancelled++; };
  const scope = scopeCounter(runner);
  assert.equal(await runner.allowRecovery(task, 'CONTINUE_EXECUTION'), true);
  assert.equal(await runner.allowRecovery(task, 'STOP_AND_REWRITE_TASK'), true);
  assert.equal(await runner.allowRecovery(task, 'START_VALIDATION'), false);
  assert.equal(scope.calls, 1);
  assert.equal(cancelled, 1);
  assert.equal(queue.runState, 'PAUSED');
  assert.equal(queue.get(task.id).output, task.output);
  assert.equal(queue.get(task.id).validationReport, task.validationReport);
  assert.equal(queue.get(task.id).description, task.description);
  assert.equal(queue.countEvents(task.id, 'recovery-replan'), 1);
  assert.match(recovery.recoveryState(queue, task).blocked, /Three recovery requests/);
  queue.resumePaused();
  const restarted = runnerFor(queue);
  const retryScope = scopeCounter(restarted);
  await restarted.replanOrPause(queue.get(task.id), 'Automatic runner restoration without an explicit Start.');
  assert.equal(retryScope.calls, 0, 'restarting the runner cannot buy another paid scope review');
  assert.equal(queue.runState, 'PAUSED');
  assert.equal(queue.countEvents(task.id, 'recovery-replan'), 1);
});

test('six recoveries cap changing observations, description rewrites and reset attempt counters', async t => {
  const queue = fixture(t);
  const original = queue.claimNext();
  const runner = runnerFor(queue);
  const scope = scopeCounter(runner);
  for (let i = 1; i <= 6; i++) {
    queue.update(original.id, { description: `Same unfinished outcome, revised wording ${i}.`, attempts: 0 });
    const task = queue.get(original.id);
    completed(queue, task, `Novel discovery ${i}`);
    assert.equal(await runner.allowRecovery(task, 'STOP_AND_REWRITE_TASK'), i < 6);
  }
  const state = recovery.recoveryState(queue, queue.get(original.id));
  assert.equal(state.recoveries, 6);
  assert.equal(state.unchanged, 0);
  assert.equal(scope.calls, 1);
  assert.equal(queue.runState, 'PAUSED');
  assert.match(state.blocked, /Six recovery requests/);
});

test('an actual successful scope split ends recovery without pausing or reviving the parent', async t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  const runner = runnerFor(queue);
  const scope = scopeCounter(runner, async () => {
    const count = queue.splitTask(task.id, [
      { title: 'First bounded outcome', description: 'Retain existing changes and prove the first behavior.' },
      { title: 'Second bounded outcome', description: 'Prove the second behavior after the first.' },
    ]);
    assert.equal(count, 2);
    runner.abandonReview();
    return false;
  });
  await runner.replanOrPause(task, 'Decompose independently verifiable remaining outcomes.');
  assert.equal(scope.calls, 1);
  assert.equal(queue.get(task.id), undefined);
  assert.equal(queue.runState, 'RUNNING');
  assert.deepEqual(queue.list().map(task => task.title), ['First bounded outcome', 'Second bounded outcome']);
  assert.ok(queue.list().every(task => task.status === 'PENDING'));
});

test('three failed progress reviews trigger a bounded re-plan instead of another supervisor loop', async t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  queue.update(task.id, { status: 'VERIFYING', output: 'Preserved worker handoff.' });
  let calls = 0;
  const runner = runnerFor(queue, { './monitor': {
    JOURNAL_EVENTS: 80, VALIDATION_FAILED: 'validation-failed',
    reviewProgress: async () => { calls++; throw Error('Supervisor returned an invalid decision.'); },
  } });
  const scope = scopeCounter(runner);
  for (let i = 0; i < 3; i++) await runner.reviewWork(queue.get(task.id));
  assert.equal(calls, 3);
  assert.equal(queue.countEvents(task.id, 'monitor-error'), 3);
  assert.equal(scope.calls, 1);
  assert.equal(queue.runState, 'PAUSED');
  assert.equal(queue.get(task.id).output, 'Preserved worker handoff.');
  assert.match(recovery.recoveryState(queue, task).blocked, /Three unsuccessful progress-review decisions/);
});

test('review-error counters are lane-specific and only a successful decision resets that lane', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  for (let i = 0; i < 2; i++) assert.equal(recovery.recoveryFailure(queue, task, 'progress-review'), '');
  assert.equal(recovery.recoveryFailure(queue, task, 'silent-review'), '');
  recovery.recoverySucceeded(queue, task, 'progress-review');
  assert.deepEqual(plain(recovery.recoveryState(queue, task).failures), { 'silent-review': 1 });
  assert.equal(recovery.recoveryFailure(queue, task, 'progress-review'), '');
  assert.equal(recovery.recoveryFailure(queue, task, 'silent-review'), '');
  assert.match(recovery.recoveryFailure(queue, task, 'silent-review'), /Three unsuccessful/);
});

test('six replayed completed outcomes freeze a live worker before its repetition can veto planning', async t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  completed(queue, task);
  recovery.recoveryEvidence(queue, task);
  for (let i = 0; i < 6; i++) completed(queue, task, 'unchanged contents', i + 2);
  let cancelled = 0;
  const runner = runnerFor(queue, { './monitor': { reviewProgress: async () => assert.fail('No further ordinary review is needed.') } });
  runner.executionAbort = () => { cancelled++; };
  const scope = scopeCounter(runner, async () => {
    assert.equal(cancelled, 1, 'freeze replaying work before invoking the scope planner');
    assert.equal(queue.get(task.id).status, 'VERIFYING');
    assert.ok(recovery.recoveryState(queue, task).blocked, 'persist the spent re-plan before awaiting the provider');
    return true;
  });
  await runner.reviewWork(task);
  assert.equal(scope.calls, 1);
  assert.equal(queue.runState, 'PAUSED');
});

test('a failed scope re-plan is not retried on restart and cannot imply completion', async t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  const runner = runnerFor(queue);
  const scope = scopeCounter(runner, async () => { throw Error('Incomplete replacement plan.'); });
  await runner.replanOrPause(task, 'Repeated unsuccessful recovery.');
  assert.equal(scope.calls, 1);
  assert.equal(queue.runState, 'PAUSED');
  assert.match(queue.get(task.id).supervisorFeedback, /Incomplete replacement plan/);
  assert.notEqual(queue.get(task.id).status, 'VERIFIED');
  queue.resumePaused();
  await runner.replanOrPause(queue.get(task.id), 'Retry unchanged');
  assert.equal(scope.calls, 1);
  assert.equal(queue.runState, 'PAUSED');
});

test('alternating previously seen outcomes across worker attempts is still repetition', t => {
  const queue = fixture(t);
  const original = queue.claimNext();
  for (const value of ['Observation A', 'Observation B']) completed(queue, original, value);
  const first = recovery.recoveryEvidence(queue, original);
  queue.update(original.id, { status: 'PENDING' });
  const second = queue.claimNext();
  for (let i = 0; i < 6; i++) completed(queue, second, i % 2 ? 'Observation B' : 'Observation A', 50 + i);
  const replay = recovery.recoveryEvidence(queue, second);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.repeats, 6);
  assert.equal(replay.seen.length, 2);
});

test('recovery ledger survives closing and reopening the queue and retains pre-crash re-plan reservation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-recovery-ledger-'));
  const file = path.join(dir, 'queue.sqlite');
  let queue = TaskQueue.open(file);
  t.after(() => {
    queue.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('mf-recovery-ledger-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  queue.replaceAll([{ title: 'Bounded behavior', description: 'Implement and check the two transitions.' }]);
  queue.setRunState('RUNNING');
  const task = queue.claimNext();
  completed(queue, task);
  recovery.recoveryRequest(queue, task);
  recovery.recoveryFailure(queue, task, 'progress-review');
  recovery.blockRecovery(queue, task, 'Automatic scope re-plan was already requested.');
  const before = plain(recovery.recoveryState(queue, task));
  queue.close();
  queue = TaskQueue.open(file);
  const reopened = load('src/queue/recovery.ts');
  assert.deepEqual(plain(reopened.recoveryState(queue, queue.get(task.id))), before);
  assert.match(reopened.recoveryRequest(queue, task), /already requested/);
  completed(queue, task, 'unchanged contents', 400);
  assert.equal(reopened.recoveryEvidence(queue, task).revision, before.revision);
  assert.equal(reopened.recoveryEvidence(queue, task).repeats, 1);
});

test('automatic rewrites cannot renew the budget, but an operator-edited blocked contract can', t => {
  const queue = fixture(t);
  const original = queue.claimNext();
  recovery.recoveryRequest(queue, original);
  queue.update(original.id, { description: 'Automatic rewording before pausing.' });
  let task = queue.get(original.id);
  assert.equal(recovery.recoveryState(queue, task).recoveries, 1);
  recovery.blockRecovery(queue, task, 'Operator intervention required.');
  queue.update(task.id, { attempts: 0, output: 'Different handoff prose is not a new contract.' });
  task = queue.get(task.id);
  assert.equal(recovery.recoveryState(queue, task).blocked, 'Operator intervention required.');
  queue.update(task.id, { description: 'A revised bounded operator contract.' });
  const state = recovery.recoveryState(queue, queue.get(task.id));
  assert.equal(state.blocked, undefined);
  assert.equal(state.recoveries, 0);
});

test('a successful ordinary progress review clears its failure count without changing acceptance status', async t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  recovery.recoveryFailure(queue, task, 'progress-review');
  const runner = runnerFor(queue, { './monitor': {
    JOURNAL_EVENTS: 80, VALIDATION_FAILED: 'validation-failed',
    reviewProgress: async () => ({ action: 'CONTINUE_EXECUTION', reason: 'One local test is still running.', usage }),
  } });
  await runner.reviewWork(task);
  assert.equal(recovery.recoveryState(queue, task).failures['progress-review'], undefined);
  assert.equal(queue.get(task.id).status, 'EXECUTING');
  assert.equal(recovery.recoveryState(queue, task).recoveries, 0);
});

test('durable paging sees every outcome and retains a long alternating replay', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  for (let i = 0; i < 700; i++) completed(queue, task, `outcome ${i}`);
  const original = recovery.recoveryEvidence(queue, task);
  assert.equal(original.seen.length, 700, 'not limited to the journal excerpt or the old fingerprint window');
  for (let i = 0; i < 700; i++) completed(queue, task, `outcome ${i}`, 99);
  for (let i = 0; i < 300; i++) queue.log(task.id, 'supervisor', 'tool', 'inspection noise');
  const replay = recovery.recoveryEvidence(queue, task);
  assert.equal(replay.revision, original.revision);
  assert.equal(replay.repeats, 700);
});

test('a pending command cannot be hidden behind hundreds of unrelated journal rows', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  const before = recovery.decisionEvidence(queue, task);
  queue.log(task.id, 'executor', 'tool', 'run_shell() \u2192 start');
  const started = queue.latestWorkerToolEventId(task.id);
  for (let i = 0; i < 400; i++) {
    queue.log(task.id, 'executor', 'activity:waiting', 'alive');
    queue.log(task.id, 'supervisor', 'tool', 'inspection');
  }
  assert.ok(started > before);
  assert.equal(recovery.decisionEvidence(queue, task), started);
});

test('changes outside the readable output excerpt are still new outcome evidence', t => {
  const queue = fixture(t);
  const task = queue.claimNext();
  completed(queue, task, 'same prefix '.repeat(300) + 'old implementation');
  const before = recovery.decisionEvidence(queue, task);
  completed(queue, task, 'same prefix '.repeat(300) + 'fixed implementation');
  assert.ok(recovery.decisionEvidence(queue, task) > before);
});

test('an operator edit during recovery planning cannot receive a stale pause or activity', async t => {
  for (const reject of [false, true]) {
    const queue = fixture(t);
    const task = queue.claimNext();
    const runner = runnerFor(queue);
    let settle, activity;
    runner.scopeWatch = (_task, _role, _current, onActivity) => {
      activity = onActivity;
      return { preflight: () => new Promise((resolve, fail) => {
        settle = () => reject ? fail(Error('late planner error')) : resolve(true);
      }), close() {} };
    };
    const pending = runner.replanOrPause(task, 'Repeated old outcome');
    queue.update(task.id, { description: 'Operator supplied a new diagnosis.', supervisorFeedback: 'Keep this new feedback',
      activityPhase: 'operator_edited', activityDetail: 'new state' });
    activity('scope_review', 'stale activity', Date.now());
    settle();
    await pending;
    assert.equal(queue.runState, 'RUNNING');
    assert.equal(queue.get(task.id).supervisorFeedback, 'Keep this new feedback');
    assert.equal(queue.get(task.id).activityPhase, 'operator_edited');
    assert.equal(recovery.recoveryState(queue, queue.get(task.id)).blocked, undefined);
  }
});
