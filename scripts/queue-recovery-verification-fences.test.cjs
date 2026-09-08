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

test('a rejected plan produces a concrete incomplete report without scheduling another recovery loop', async t => {
  const f = setup(t, async () => { throw Object.assign(Error('Invalid tool argument: expression.'),
    { name: 'VerificationPlanError', usage }); });
  const schedule = f.load('src/queue/recoverySchedule.ts');
  f.runner.pauseForRecovery(f.task, 'Old adapter recovery loop.');
  const review = { taskId:f.task.id, seq:f.task.seq, gen:++f.runner.reviewGen, lastActivityAt:Date.now() };
  await f.runner.verifyWithExecutor(f.queue.get(f.task.id), review);
  assert.equal(schedule.readRecoveryJob(f.queue, f.task).active, false);
  const current = f.queue.get(f.task.id);
  const report = JSON.parse(current.validationReport);
  assert.equal(report.conclusion, 'INCOMPLETE');
  assert.match(report.remaining, /Invalid tool argument/);
  assert.equal(current.status, 'VERIFYING');
  assert.equal(current.tokensIn, usage.input);
  assert.equal(f.runner.currentHostVerification(current), true);
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
