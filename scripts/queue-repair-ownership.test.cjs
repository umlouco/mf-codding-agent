const { assert, test, fixture, orchestrator, usage } = require('./queue-progress-helpers.cjs');

const ownershipError = path => `queue ownership: supervisor test repair cannot rewrite application file ${path}; return an implementation repair decision`;

function repairRunner(queue, runOnce) {
  const runner = orchestrator(queue, {
    './agents': { coreHalted: reason => reason === 'repeated_tool_error', runOnce },
  });
  runner.replacements = [];
  runner.requestFailureDecomposition = (task, reason) => runner.replacements.push({ task, reason });
  runner.verifyWithExecutor = async () => assert.fail('rejected repair must not validate unchanged application files');
  return runner;
}

test('streamed application ownership errors override a misleading successful repair handoff', async t => {
  for (const path of ['frontend/src/components/tabs/PerfTestTab.vue', 'lib/server/InvoiceController.ts']) {
    const queue = fixture(t);
    const claimed = queue.claimNext();
    queue.update(claimed.id, { output: 'Original implementation handoff', validationReport: 'Original failed host report' });
    const current = queue.get(claimed.id);
    let aborted = 0;
    const runner = repairRunner(queue, async (_context, _output, _role, _prompt, options) => {
      options.onAbort(() => aborted++);
      options.onEvent('stream/tool', { id: 'repair', name: 'edit_file', status: 'running', input: { path } });
      options.onEvent('stream/tool', { id: 'repair', name: 'edit_file', status: 'error', output: ownershipError(path), elapsedMs: 6 });
      return { text: 'All changes are complete; ready to validate.', stopReason: 'end_turn', usage };
    });
    await runner.repairTests(current, 'Repair the concrete test failure');
    assert.equal(aborted, 1, 'ownership rejection cancels the repair immediately');
    assert.equal(runner.replacements.length, 1);
    assert.equal(runner.replacements[0].task.id, current.id);
    assert.equal(runner.replacements[0].task.output, current.output, 'keep the executor handoff for the replacement archive');
    assert.equal(runner.replacements[0].task.validationReport, current.validationReport, 'keep the actual failure report, not repair claims');
    assert.match(runner.replacements[0].reason, /queue ownership:/);
    assert.ok(runner.replacements[0].reason.includes(path), 'preserve the actual blocked path, without project-specific routing');
    assert.equal(queue.countEvents(current.id, 'test-repair-halted'), 1);
    assert.ok(queue.events(current.id, 20).some(e => e.kind === 'tool' && e.message.includes(ownershipError(path))));
    assert.notEqual(queue.get(current.id).status, 'FAILED');
  }
});

test('a repair process killed by its ownership guard still requests decomposition', async t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  const error = ownershipError('src/components/Dashboard.vue');
  const runner = repairRunner(queue, async (_context, _output, _role, _prompt, options) => {
    let reject;
    const pending = new Promise((_resolve, failure) => { reject = failure; });
    options.onAbort(() => reject(Object.assign(new Error('core process killed'), { usage })));
    options.onEvent('stream/tool', { id: 'repair', name: 'edit_file', status: 'error', output: error });
    return pending;
  });
  await runner.repairTests(current, 'Repair reported failure');
  assert.equal(runner.replacements.length, 1);
  assert.equal(runner.replacements[0].reason, error, 'keep actionable tool evidence, not the abort transport error');
  assert.equal(queue.countEvents(current.id, 'test-repair-halted'), 1);
  assert.equal(queue.get(current.id).tokensIn, usage.input, 'aborted repair usage is recorded exactly once');
  assert.equal(runner.review, null);
});

test('a cancelled repair cannot schedule replacements from its late ownership error', async t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  let options, finish;
  const runner = repairRunner(queue, (_context, _output, _role, _prompt, opts) => {
    options = opts;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = runner.repairTests(current, 'Repair test');
  runner.reviewGen++;
  options.onEvent('stream/tool', { id: 'late', name: 'edit_file', status: 'error', output: ownershipError('src/app.ts') });
  finish({ text: 'Late report', stopReason: 'end_turn', usage });
  await pending;
  assert.equal(runner.replacements.length, 0);
  assert.equal(queue.countEvents(current.id, 'test-repair-halted'), 0);
  assert.equal(queue.get(current.id).output, '');
});

test('an observed ownership failure survives Pause before abort settles and Start schedules decomposition', async t => {
  const queue = fixture(t);
  const claimed = queue.claimNext();
  queue.update(claimed.id, { output: 'Original worker evidence', validationReport: 'Original rejected report' });
  const current = queue.get(claimed.id);
  let options, reject, plans = 0, repairs = 0;
  const runner = orchestrator(queue, {
    './agents': { coreHalted: () => false, runOnce: (_context, _output, _role, _prompt, opts) => {
      repairs++;
      options = opts;
      opts.onAbort(() => {}); // Reproduce delayed process shutdown after the host has requested it.
      return new Promise((_resolve, failure) => { reject = failure; });
    } },
    './failureDecomposition': { decideFailureDecomposition: async () => {
      plans++;
      throw new Error('Provider unavailable during replacement planning');
    } },
  });
  runner.verifyWithExecutor = async () => assert.fail('rejected application edit proceeded to validation');
  t.after(() => { runner.disposed = true; });
  runner.arm = () => {};
  runner.watchdog = true;
  runner.decompositionWorkspaceRevision = () => 'unchanged-workspace';
  const pending = runner.repairTests(current, 'Repair test');
  const error = ownershipError('src/widgets/Alerts.vue');
  options.onEvent('stream/tool', { id: 'blocked', name: 'edit_file', status: 'error', output: error });
  assert.equal(queue.get(current.id).activityPhase, 'decomposition_required');
  assert.equal(queue.get(current.id).activityDetail, error);
  runner.pause();
  reject(new Error('process stopped after Pause'));
  await pending;
  assert.equal(queue.runState, 'PAUSED');
  assert.equal(queue.get(current.id).output, current.output);
  assert.equal(queue.get(current.id).validationReport, current.validationReport);
  runner.start();
  await runner.serviceFailureDecomposition(queue.get(current.id));
  assert.equal(plans, 1, 'Start retains the mandatory replacement path');
  assert.equal(repairs, 1, 'Start must not repeat the ownership-rejected repair');
  assert.equal(queue.claimNext(), undefined, 'the rejected original cannot execute while its split is pending');
  assert.match(queue.get(current.id).activityPhase, /^decomposition_/);
  runner.disposed = true; // Suppress Start's deferred timer after this isolated queue closes.
});

test('an unsuccessful supervisor repair cannot restart through persisted repair feedback', async t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  let calls = 0;
  const runner = repairRunner(queue, async () => {
    calls++;
    return { text: 'Could not finish', stopReason: 'repeated_tool_error', usage };
  });
  await runner.repairTests(current, 'Fix the failed check');
  await runner.repairTests(queue.get(current.id), '[SUPERVISOR_TEST_REPAIR] Fix the failed check');
  assert.equal(calls, 1, 'a persisted marker cannot admit an identical exhausted repair');
  assert.equal(runner.replacements.length, 2, 'both dispatches require replacement, never a repair replay');
});

test('executor ownership handoff after an earlier supervisor repair requires a split, not another repair', async t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  queue.update(current.id, { status: 'VERIFYING',
    errorLog: `[attempt ${current.attempts}] the core stopped the turn (supervisor_repair_required).`,
    output: 'queue ownership: the supervisor must rewrite existing test login.spec.ts.' });
  queue.log(current.id, 'supervisor', 'test-repair-started', 'An earlier repair already ran');
  const runner = repairRunner(queue, async () => assert.fail('executor blocker retriggered the same supervisor repair'));
  await runner.reviewWork(queue.get(current.id));
  assert.equal(runner.replacements.length, 1);
  assert.match(runner.replacements[0].reason, /after a supervisor repair/);
});

test('a legitimate scoped test repair still proceeds to independent verification', async t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  let verified = 0;
  const runner = repairRunner(queue, async (_context, _output, _role, _prompt, options) => {
    options.onAbort(() => assert.fail('valid test repair was aborted'));
    options.onEvent('stream/tool', { id: 'read', name: 'read_file', status: 'ok', output: ownershipError('src/app.ts') });
    options.onEvent('stream/tool', { id: 'repair', name: 'edit_file', status: 'running', input: { path: 'tests/dashboard.spec.ts' } });
    options.onEvent('stream/tool', { id: 'repair', name: 'edit_file', status: 'ok', output: 'Updated the broken test fixture' });
    return { text: 'Fixed the fixture; focused test passed.', stopReason: 'end_turn', usage };
  });
  runner.verifyWithExecutor = async task => { assert.equal(task.id, current.id); verified++; };
  await runner.repairTests(current, 'Fix the broken fixture');
  assert.equal(verified, 1);
  assert.equal(runner.replacements.length, 0);
  assert.equal(queue.countEvents(current.id, 'test-repair-halted'), 0);
});
