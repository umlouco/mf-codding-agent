const { test } = require('node:test');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

test('public Start migrates a legacy blocked VERIFYING task through the real recovery and verifier lanes', async t => {
  let verificationCalls = 0;
  const report = JSON.stringify({ conclusion: 'INCOMPLETE', summary: 'A real check remains unavailable.',
    implementationEvidence: 'Current implementation inspected.', behaviorEvidence: '',
    checks: [], remaining: 'Test service unavailable.', observedTools: [] });
  const f = fixture(t, {}, { './verification': {
    runVerification: async (_context, _output, task, _goal, activity, event) => {
      verificationCalls++;
      assert.equal(task.solutionVerifyCommand, 'existing-check --assert-behavior');
      assert.equal(f.schedule.hasRecoveryJob(f.queue, task), true, 'the recovery owns verification until it finishes');
      assert.match(f.recovery.recoveryState(f.queue, task).blocked, /Six recovery/,
        'legacy history is retained while the changed verifier operation runs');
      activity({ phase: 'tool', detail: 'Inspecting the changed verification adapter.', at: Date.now() });
      event('stream/tool', { id: 'inspection', name: 'read_file', status: 'running', input: { path: 'test-config.json' } });
      event('stream/tool', { id: 'inspection', name: 'read_file', status: 'ok', output: '{"configured":true}' });
      return { text: report, validationReport: report, stopReason: 'end_turn', usage };
    },
  } });
  t.after(() => { f.runner.disposed = true; f.runner.disarm(); clearInterval(f.runner.watchdog); });
  f.schedule = f.load('src/queue/recoverySchedule.ts');
  f.recovery = f.load('src/queue/recovery.ts');
  const first = f.queue.list()[0];
  f.queue.update(first.id, { status: 'VERIFYING', attempts: 4, output: 'Preserved partial implementation.',
    validationReport: 'Old incomplete report.', errorLog: 'Original failed invocation.',
    solutionVerifyCommand: 'existing-check --assert-behavior' });
  const before = f.queue.get(first.id);
  const ledger = f.recovery.recoveryState(f.queue, before);
  ledger.recoveries = 6;
  ledger.blocked = 'Six recovery requests on the same unfinished task.';
  f.recovery.saveRecovery(f.queue, before, ledger);
  f.queue.pauseOpen();
  f.setReply({ action: 'VERIFY', reason: 'The prior invocation used the wrong adapter.',
    guidance: 'Inspect the actual test configuration, then execute the corrected typed check.',
    nextOperation: { tool: 'read_file', input: { path: 'test-config.json' } } });
  f.runner.scopeWatch = () => ({ preflight: async () => true, observe() {}, close() {} });
  f.runner.reviewWork = async () => assert.fail('Legacy recovery must not rerun ordinary review.');
  f.runner.supervise = async () => assert.fail('The old report must not be supervised during recovery.');

  f.runner.start();
  await new Promise(resolve => setTimeout(resolve, 1200));

  assert.equal(verificationCalls, 1, 'the real verifyWithExecutor must reach the verifier despite the legacy blocked flag');
  assert.equal(f.calls.length, 1, 'one real recovery decision, no repeated supervision');
  assert.equal(f.queue.runState, 'RUNNING');
  const after = f.queue.get(first.id);
  assert.equal(after.status, 'VERIFYING', 'new recovery evidence is not automatic completion');
  assert.equal(after.validationReport, report);
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'errorLog', 'attempts']) assert.equal(after[field], before[field], field);
  assert.equal(f.schedule.readRecoveryJob(f.queue, after).active, false);
  assert.equal(f.recovery.recoveryState(f.queue, after).recoveries, 6);
  assert.equal(f.recovery.recoveryState(f.queue, after).blocked, undefined);
  assert.equal(f.queue.countEvents(after.id, 'validation-started'), 1);
  assert.equal(f.queue.list()[1].status, 'PENDING');
});
