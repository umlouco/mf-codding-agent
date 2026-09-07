const { test } = require('node:test');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

const operation = { tool: 'read_file', input: { path: 'src/service.ts' } };
const decision = (action = 'EXECUTE') => ({ action, reason: 'The test reports an incorrect return value.',
  guidance: 'Fix the observed return branch without changing assertions.', nextOperation: operation });

function setup(t, value = decision()) {
  const f = fixture(t);
  f.setReply(value);
  const first = f.queue.list()[0];
  f.queue.update(first.id, { status: 'VERIFYING', attempts: 9, output: 'Keep existing work.',
    validationReport: 'Previous captured report.', errorLog: 'Prior failures.' });
  f.task = f.queue.get(first.id);
  f.schedule = f.load('src/queue/recoverySchedule.ts');
  f.recovery = f.load('src/queue/recovery.ts');
  f.runner.pauseForRecovery(f.task, 'An unchanged retry cannot recover this failure.');
  return f;
}

test('recovery compiles a changed executor operation without rewriting acceptance or renewing attempts', async t => {
  const f = setup(t);
  await f.runner.serviceRecovery(f.task);
  const current = f.queue.get(f.task.id);
  assert.equal(current.status, 'PENDING');
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.schedule.readRecoveryJob(f.queue, current).active, false);
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'validationReport', 'attempts', 'errorLog']) assert.equal(current[field], f.task[field], field);
  assert.match(current.supervisorFeedback, /incorrect return value/);
  assert.equal(f.calls.length, 1, 'one bounded planning turn, no reformat/replan burst');
  assert.equal(f.calls[0][4].formatOnly, true);
  assert.equal(f.calls[0][4].maxIterations, 1);
});

test('paraphrasing a failed operation cannot buy another executor attempt', async t => {
  const f = setup(t);
  await f.runner.serviceRecovery(f.task);
  const current = f.queue.get(f.task.id);
  f.queue.update(current.id, { status: 'VERIFYING' });
  f.setReply({ ...decision(), guidance: 'A newly worded instruction to do the same thing.' });
  f.runner.pauseForRecovery(f.queue.get(current.id), 'Unchanged outcome.');
  await f.runner.serviceRecovery(f.queue.get(current.id));
  assert.equal(f.queue.get(current.id).status, 'VERIFYING');
  assert.equal(f.queue.runState, 'RUNNING');
  assert.match(f.schedule.readRecoveryJob(f.queue, current).lastError, /already failed or was admitted/);
});

test('VERIFY obtains new receipts with the same scheduler owner and keeps the preceding report until replaced', async t => {
  const f = setup(t, decision('VERIFY'));
  f.runner.verifyWithExecutor = async (task, review) => {
    assert.equal(task.validationReport, f.task.validationReport);
    assert.equal(review.gen, f.runner.reviewGen);
    assert.equal(f.schedule.hasRecoveryJob(f.queue, task), true);
    f.queue.update(task.id, { validationReport: 'Fresh host report: incomplete, one defect observed.' });
  };
  await f.runner.serviceRecovery(f.task);
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING', 'a recovery action is not acceptance');
  assert.equal(f.schedule.readRecoveryJob(f.queue, f.task).active, false);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('VERIFY without a new host report is deferred automatically, never accepted as progress', async t => {
  const f = setup(t, decision('VERIFY'));
  f.runner.verifyWithExecutor = async () => {};
  await f.runner.serviceRecovery(f.task);
  const job = f.schedule.readRecoveryJob(f.queue, f.task);
  assert.equal(job.active, true);
  assert.match(job.lastError, /no new host report/);
  assert.equal(f.queue.get(f.task.id).validationReport, f.task.validationReport);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('a decided recovery split commits every child and deletes the original instead of replanning it', async t => {
  const parts = ['first', 'second'].map(title => ({ title, description: `Finish ${title} outcome.`,
    implVerifyPrompt: `Inspect ${title}.`, solutionVerifyPrompt: `Exercise ${title}.`, solutionVerifyCommand: '' }));
  const f = setup(t, { ...decision('SPLIT'), splitInto: parts });
  await f.runner.serviceRecovery(f.task);
  assert.equal(f.queue.get(f.task.id), undefined);
  assert.deepEqual(Array.from(f.queue.list(), task => task.title), ['first', 'second', 'Later work']);
  assert.equal(f.calls.length, 1, 'a split decision is executed, not sent back to another planner');
  assert.equal(f.queue.runState, 'RUNNING');
});

test('malformed recovery decision becomes scheduled work without granting an unchanged retry', async t => {
  const f = setup(t, { action: 'EXECUTE', reason: 'Try again', guidance: 'Do the task' });
  await f.runner.serviceRecovery(f.task);
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
  assert.equal(f.schedule.readRecoveryJob(f.queue, f.task).active, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('user Pause fences a recovery decision already in flight', async t => {
  const f = setup(t);
  let resolve;
  // Replace the actual planner dependency in an independently loaded fixture.
  const g = fixture(t, {}, { './recoveryDecision': {
    decideRecovery: async () => new Promise(done => { resolve = done; }), recoveryOperation: value => value,
  } });
  const task = g.queue.list()[0];
  g.queue.update(task.id, { status: 'VERIFYING' });
  g.runner.pauseForRecovery(g.queue.get(task.id), 'Await diagnosis.');
  const running = g.runner.serviceRecovery(g.queue.get(task.id));
  g.runner.pause();
  resolve({ decision: decision(), usage });
  await running;
  assert.equal(g.queue.runState, 'PAUSED');
  assert.notEqual(g.queue.get(task.id).status, 'PENDING');
});

test('operational identity ignores rationale and JSON object key order; no stop/success fallback exists', t => {
  const f = fixture(t);
  const { parseRecoveryDecision, recoveryOperation } = f.load('src/queue/recoveryDecision.ts');
  for (const action of ['PAUSE', 'STOP', 'VERIFIED', 'KEEP', 'RETRY']) {
    assert.throws(() => parseRecoveryDecision(JSON.stringify({ ...decision(), action }), f.queue.list()[0]));
  }
  const a = { ...decision(), nextOperation: { tool: 'unix', input: { command: 'npm test', timeout_ms: 1000 } } };
  const b = { ...a, reason: 'new prose', nextOperation: { input: { timeout_ms: 1000, command: 'npm test' }, tool: 'unix' } };
  assert.equal(JSON.stringify(recoveryOperation(a)), JSON.stringify(recoveryOperation(b)));
});
