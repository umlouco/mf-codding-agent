const { test } = require('node:test');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

const receipt = { stepId: 'observe', kind: 'tool', name: 'browser_eval', input: { script: 'document.querySelector("svg") !== null' },
  output: 'false', executionSucceeded: true, assertion: 'unasserted', passed: true, problem: '', truncated: false };
const report = receipts => JSON.stringify({ conclusion: 'INCOMPLETE', remaining: 'Required view has not been opened.',
  verificationPlan: { version: 1 }, verificationReceipts: receipts });

test('an unasserted observation cannot authorize code edits through supervisor RETRY feedback', async t => {
  const f = fixture(t, { superviseTask: async () => ({ verdict: 'RETRY', usage,
    feedback: 'Add a new visualization on the unrelated initial page within an invented time limit.',
    taskEdits: [{ seq: 1, description: 'Invented expanded outcome.' }] }) });
  const original = f.queue.list()[0];
  f.queue.update(original.id, { status: 'VERIFYING', validationReport: report([receipt]) });
  const before = f.queue.get(original.id);
  let verified = 0;
  f.runner.verifyWithExecutor = async task => {
    verified++;
    assert.match(task.supervisorFeedback, /no successfully executed, explicitly failed/);
    assert.doesNotMatch(task.supervisorFeedback, /Add a new visualization/);
  };
  await f.runner.supervise(before);
  assert.equal(verified, 1);
  assert.equal(f.queue.get(original.id).status, 'VERIFYING');
  assert.equal(f.queue.get(original.id).description, original.description);
  assert.equal(f.queue.countEvents(original.id, 'retry-evidence-rejected'), 1);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('scheduled recovery also rejects EXECUTE justified only by missing evidence', async t => {
  const f = fixture(t);
  const task = f.queue.list()[0];
  f.queue.update(task.id, { status: 'VERIFYING', validationReport: report([receipt]) });
  f.setReply({ action: 'EXECUTE', reason: 'A queried element is missing.', guidance: 'Add an unrequested element.',
    nextOperation: { tool: 'edit_file', input: { path: 'src/view.ts' } } });
  f.runner.pauseForRecovery(f.queue.get(task.id), 'Find actual failure evidence.');
  await f.runner.serviceRecovery(f.queue.get(task.id));
  assert.equal(f.queue.get(task.id).status, 'VERIFYING');
  const { readRecoveryJob } = f.load('src/queue/recoverySchedule.ts');
  assert.match(readRecoveryJob(f.queue, task).lastError, /no successfully executed, explicitly failed/);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('a failed executed assertion admits focused repair, but a tool failure or truncated result does not', t => {
  const f = fixture(t);
  const { implementationRetryProblem } = f.load('src/queue/verificationRecovery.ts');
  const task = f.queue.list()[0];
  assert.equal(implementationRetryProblem({ ...task, validationReport: report([{ ...receipt,
    assertion: 'failed', passed: false, problem: 'Observed JSON does not equal the expected value.' }]) }), '');
  for (const change of [{ executionSucceeded: false, problem: 'execution error' },
    { truncated: true }, { problem: 'The shell reported an invocation failure.' }]) {
    assert.ok(implementationRetryProblem({ ...task, validationReport: report([{ ...receipt, assertion: 'failed', ...change }]) }));
  }
  assert.equal(implementationRetryProblem({ ...task, kind: 'phase', validationReport: report([]) }), '', 'phase expansion has no product assertion yet');
});
