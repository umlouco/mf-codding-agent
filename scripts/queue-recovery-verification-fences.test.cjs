const { test } = require('node:test');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

function setup(t, verifier) {
  const f = fixture(t, {}, { './verification': { runVerification: verifier } });
  const first = f.queue.list()[0];
  f.queue.update(first.id, { status: 'VERIFYING', validationReport: 'Old incomplete report.', attempts: 6 });
  f.task = f.queue.get(first.id);
  f.runner.scopeWatch = () => ({ preflight: async () => true, observe() {}, close() {} });
  return f;
}

test('an owner goal change during host verification fences the old report', async t => {
  let release;
  const f = setup(t, () => new Promise(resolve => { release = resolve; }));
  const review = { taskId: f.task.id, seq: f.task.seq, gen: ++f.runner.reviewGen, lastActivityAt: Date.now() };
  const running = f.runner.verifyWithExecutor(f.task, review);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  f.queue.setMeta('goal', 'Owner changed the actual required behavior.');
  release({ text: 'stale report', validationReport: 'stale PASS', usage });
  await running;
  assert.equal(f.queue.get(f.task.id).validationReport, f.task.validationReport);
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
});

test('a rejected plan inside scheduled recovery preserves its owner and sets backoff after the failure', async t => {
  const f = setup(t, async () => { throw Object.assign(Error('Invalid tool argument: expression.'),
    { name: 'VerificationPlanError', usage }); });
  f.setReply({ action: 'VERIFY', reason: 'Incorrect browser tool invocation.',
    guidance: 'Compile checks against actual tool schemas.',
    nextOperation: { tool: 'browser_eval', input: { script: 'document.title' } } });
  const schedule = f.load('src/queue/recoverySchedule.ts');
  f.runner.pauseForRecovery(f.task, 'Diagnose the invalid adapter.');
  const before = Date.now();
  await f.runner.serviceRecovery(f.task);
  const job = schedule.readRecoveryJob(f.queue, f.task);
  assert.equal(job.active, true);
  assert.match(job.lastError, /Invalid tool argument/);
  assert.ok(job.dueAt >= before + 5000, 'the failed await cannot cause an immediately due replay');
  assert.equal(f.queue.get(f.task.id).validationReport, f.task.validationReport);
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.countEvents(f.task.id, 'recovery-deferred'), 1);
  assert.equal(f.queue.get(f.task.id).tokensIn, usage.input * 2, 'both planner and failed verifier usage counted exactly once');
});

test('REVERIFY cannot invent a mandatory saved shell command for an admitted child with none', t => {
  const f = setup(t, async () => assert.fail('No verification should execute.'));
  const parts = ['one', 'two'].map(title => ({ title, description: `Implement ${title}.`,
    implVerifyPrompt: `Inspect ${title}.`, solutionVerifyPrompt: `Test ${title}.`, solutionVerifyCommand: '' }));
  f.runner.applyVerdictSplit(f.task, { verdict: 'SPLIT', feedback: 'Independent outcomes.', splitInto: parts, usage }, () => true);
  const child = f.queue.list()[0];
  f.queue.update(child.id, { status: 'VERIFYING' });
  f.runner.applyTaskEdits({ verdict: 'REVERIFY', feedback: 'Run checks.', usage,
    taskEdits: [{ seq: child.seq, solutionVerifyCommand: 'browser_open https://invalid.example' }] }, child.seq);
  assert.equal(f.queue.get(child.id).solutionVerifyCommand, '');
  assert.equal(f.queue.get(child.id).region, child.region);
  assert.equal(f.queue.countEvents(child.id, 'scope-edit-rejected'), 1);
});
