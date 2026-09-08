const { test } = require('node:test');
const { assert, fixture, orchestrator, usage, load, report } = require('./queue-progress-helpers.cjs');
const { loader } = require('./queue-scope-helpers.cjs');
const planner = loader({ './agents': { extractJson: text => JSON.parse(text) } })('src/queue/failureDecomposition.ts');
const schedule = load('src/queue/recoveryDecomposition.ts');
const rejectedEdit = 'queue ownership: supervisor test repair cannot rewrite application file frontend/src/components/tabs/PerfTestTab.vue; return an implementation repair decision';

function proposalFor(current) {
  const ids = ['show', 'clear'];
  const proposal = {
    verdict: 'SPLIT', feedback: 'Separate the observed implementation correction from independent clearing verification.',
    remainingOutcomes: [{ id: 'show', description: 'The enabling transition displays the field.' },
      { id: 'clear', description: 'The disabling transition clears the hidden value.' }],
    coverage: ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']
      .filter(field => current[field]).map(field => ({ field, requirement: current[field], outcomeIds: ids })),
    splitInto: [
      { title: 'Correct the enabling transition', description: 'Executor: correct the observed field enabling branch without changing unrelated behavior.',
        implVerifyPrompt: 'Inspect the enabling handler.', solutionVerifyPrompt: 'Confirm the enabled field is visible.',
        solutionVerifyCommand: '', outcomeIds: ['show'] },
      { title: 'Verify hidden-field clearing', description: 'Use the implementation handoff to independently verify that disabling the control clears the hidden value.',
        implVerifyPrompt: 'Inspect the clearing branch and its existing checks.',
        solutionVerifyPrompt: 'Confirm disabling clears the value and restores the hidden state.',
        solutionVerifyCommand: current.solutionVerifyCommand, outcomeIds: ['clear'] },
    ], taskEdits: [],
  };
  return proposal;
}
const replacement = current => planner.parseFailureDecomposition(JSON.stringify(proposalFor(current)), current, [], usage);
const disposeFixtureRunner = runner => { runner.disposed = true; runner.disarm(); clearInterval(runner.watchdog); };

function setup(t, decide, dependencies = {}) {
  const queue = fixture(t);
  queue.addAll([{ title: 'Unrelated later task', description: 'This work retains its relative order.' }]);
  const first = queue.claimNext();
  queue.update(first.id, { status: 'VERIFYING', implVerifyPrompt: 'Inspect both transition handlers.',
    solutionVerifyPrompt: 'Exercise both transitions without stale hidden values.', solutionVerifyCommand: 'npm run test:fields',
    output: 'Existing form changes are saved; the supervisor edit was rejected.',
    errorLog: `[attempt 1] ${rejectedEdit}`, validationReport: 'The preceding independent report remains unverified.' });
  const calls = [];
  const makeRunner = () => {
    const runner = orchestrator(queue, {
      './failureDecomposition': { ...planner, decideFailureDecomposition: async (...args) => {
        calls.push(args);
        return decide ? decide(...args) : replacement(args[2]);
      } },
      './monitor': { VALIDATION_FAILED: 'validation-failed', shellWaitViolation: () => '', correctLocalTestingTarget: () => undefined },
      ...dependencies,
    });
    runner.decompositionWorkspaceRevision = () => 'workspace-revision-unchanged';
    runner.pump = async () => {};
    return runner;
  };
  const runner = makeRunner();
  t.after(() => disposeFixtureRunner(runner));
  return { queue, task: queue.get(first.id), runner, calls, makeRunner };
}

function requireSplit(f, reason = rejectedEdit) {
  f.runner.requestFailureDecomposition(f.queue.get(f.task.id), reason);
  const current = f.queue.get(f.task.id);
  assert.equal(current.status, 'VERIFYING');
  assert.ok(schedule.requiresDecomposition(current));
  return current;
}
const service = f => f.runner.serviceFailureDecomposition(f.queue.get(f.task.id));
function dueNow(f) {
  const job = schedule.readDecomposition(f.queue, f.task);
  job.dueAt = 0;
  schedule.saveDecomposition(f.queue, f.task, job);
}

test('an ownership-rejected task is atomically replaced and deleted, with original goal and exact evidence', async t => {
  const f = setup(t);
  requireSplit(f);
  await service(f);
  assert.equal(f.calls.length, 1);
  const [, , snapshot, input] = f.calls[0];
  assert.equal(snapshot.id, f.task.id);
  assert.equal(input.goal, f.queue.getMeta('goal'));
  assert.ok(input.ownerInstructions.includes(f.queue.instructions));
  assert.ok(input.evidence.includes(rejectedEdit));
  assert.equal(input.handoff, f.task.output);
  assert.equal(f.queue.get(f.task.id), undefined, 'the original must not stay runnable beside its children');
  assert.deepEqual(Array.from(f.queue.list(), row => row.title),
    ['Correct the enabling transition', 'Verify hidden-field clearing', 'Unrelated later task']);
  assert.deepEqual(Array.from(f.queue.list(), row => row.seq), [1, 2, 3]);
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.stats().usage.input, usage.input);
  const archiveKey = JSON.parse(f.queue.list()[0].region).scopeSplit.archiveKey;
  const archive = JSON.parse(f.queue.getMeta(archiveKey));
  assert.equal(archive.task.errorLog, f.task.errorLog);
  assert.equal(archive.task.output, f.task.output);
  assert.equal(archive.task.validationReport, f.task.validationReport);
  assert.equal(archive.decision.decomposition.coverage.length, 4);
  assert.equal(f.queue.claimNext().title, 'Correct the enabling transition');
});

test('exhausted verification schedules decomposition rather than another verifier or a FAILED row', async t => {
  let verifies = 0;
  const f = setup(t, undefined, { './verification': { runVerification: async () => {
    verifies++;
    return { text: 'Check remains incomplete.', validationReport: JSON.stringify({ ...report(), conclusion: 'INCOMPLETE' }), usage };
  } } });
  for (let i = 0; i < 2; i++) f.queue.log(f.task.id, 'validator', 'verification-pass', 'Previous unsuccessful pass.');
  await f.runner.startIndependentVerification(f.queue.get(f.task.id));
  assert.equal(verifies, 0, 'the spent verification allowance cannot run an identical third pass');
  assert.ok(schedule.requiresDecomposition(f.queue.get(f.task.id)));
  await service(f);
  assert.equal(f.queue.get(f.task.id), undefined);
  assert.equal(f.queue.list().length, 3);
  assert.equal(f.queue.anyFailed(), false);
});

test('SQL failure inserting any child rolls back every child and retains the failed parent evidence', async t => {
  const f = setup(t);
  requireSplit(f);
  f.queue.db.exec(`CREATE TRIGGER reject_second_replacement BEFORE INSERT ON tasks
    WHEN NEW.title = 'Verify hidden-field clearing' BEGIN SELECT RAISE(ABORT, 'Simulated second-child insert failure'); END;`);
  await service(f);
  const current = f.queue.get(f.task.id);
  assert.ok(current, 'a failed replacement transaction cannot delete its parent');
  assert.deepEqual(Array.from(f.queue.list(), row => row.id), [f.task.id, f.task.id + 1]);
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'validationReport', 'errorLog', 'attempts']) assert.equal(current[field], f.task[field], field);
  assert.equal(current.status, 'VERIFYING');
  assert.ok(schedule.requiresDecomposition(current));
  assert.match(schedule.readDecomposition(f.queue, f.task).lastError, /Simulated second-child insert failure/);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('Stop or a changed owner request fences an already-running replacement decision', async t => {
  for (const change of ['stop', 'goal', 'instructions', 'contract']) {
    let release;
    const f = setup(t, () => new Promise(resolve => { release = resolve; }));
    requireSplit(f);
    const running = service(f);
    assert.equal(typeof release, 'function');
    if (change === 'stop') f.runner.stop();
    if (change === 'goal') f.queue.setMeta('goal', 'The owner supplied a materially changed objective.');
    if (change === 'instructions') f.queue.setInstructions('Use the newly supplied authorized environment.');
    if (change === 'contract') f.queue.update(f.task.id, { solutionVerifyPrompt: 'Also verify keyboard navigation.' });
    release(replacement(f.task));
    await running;
    assert.ok(f.queue.get(f.task.id), `${change}: superseded decision must not delete the parent`);
    assert.equal(f.queue.list().length, 2, `${change}: no stale children committed`);
  }
});

test('an invalid plan cannot purchase unchanged provider calls through ticks, reload, or Start', async t => {
  const f = setup(t, async () => { throw new planner.FailureDecompositionError('The proposed child clones its parent.', '{"verdict":"SPLIT"}', usage); });
  requireSplit(f);
  await service(f);
  assert.equal(f.calls.length, 1);
  const saved = schedule.readDecomposition(f.queue, f.task);
  assert.equal(saved.awaitingChange, true);
  assert.equal(f.queue.get(f.task.id).tokensIn, 1);
  for (let i = 0; i < 4; i++) { dueNow(f); await f.runner.runNow(); }
  assert.equal(f.calls.length, 1, 'clock and cron activity are not new failure evidence');
  const reloaded = f.makeRunner();
  t.after(() => disposeFixtureRunner(reloaded));
  dueNow(f);
  await reloaded.serviceFailureDecomposition(f.queue.get(f.task.id));
  assert.equal(f.calls.length, 1, 'a fresh orchestrator cannot reset persisted plan rejection');
  reloaded.stop();
  reloaded.watchdog = { testSentinel: true }; // Start must not create an actual interval in this fixture.
  reloaded.arm = () => {};
  reloaded.start();
  await reloaded.runNow();
  reloaded.stop();
  assert.equal(f.calls.length, 1, 'explicit Start resumes scheduling, not the spent identical plan');
  assert.ok(f.queue.get(f.task.id));
  assert.equal(f.queue.isComplete(), false);
});

test('transient provider retries are delayed and capped at three for the same persisted inputs', async t => {
  const f = setup(t, async () => { throw Error('Provider unavailable.'); });
  requireSplit(f);
  await service(f);
  await service(f);
  assert.equal(f.calls.length, 1, 'a tick before dueAt cannot call the provider');
  for (let i = 0; i < 5; i++) { dueNow(f); await service(f); }
  assert.equal(f.calls.length, 3);
  assert.equal(schedule.readDecomposition(f.queue, f.task).awaitingChange, true);
  const reloaded = f.makeRunner();
  t.after(() => disposeFixtureRunner(reloaded));
  dueNow(f);
  await reloaded.serviceFailureDecomposition(f.queue.get(f.task.id));
  assert.equal(f.calls.length, 3, 'reload preserves transport accounting');
  assert.equal(f.queue.runState, 'RUNNING');
});

test('the archived parent chain reaches replacement planning and cannot be recreated as a descendant', async t => {
  const f = setup(t);
  requireSplit(f);
  await service(f);
  const child = f.queue.list()[0];
  f.task = child;
  f.queue.update(child.id, { status: 'VERIFYING' });
  let seen;
  const runner = orchestrator(f.queue, { './failureDecomposition': { ...planner,
    decideFailureDecomposition: async (_context, _output, current, input) => {
      seen = input.ancestry;
      const proposal = proposalFor(current);
      proposal.splitInto[0].description = input.ancestry[0].description;
      try { return planner.parseFailureDecomposition(JSON.stringify(proposal), current, input.ancestry, usage); }
      catch (error) { throw new planner.FailureDecompositionError(error.message, JSON.stringify(proposal), usage); }
    } } });
  runner.decompositionWorkspaceRevision = () => 'workspace-revision-unchanged';
  runner.requestFailureDecomposition(f.queue.get(child.id), 'The child encountered a distinct observed defect.');
  await runner.serviceFailureDecomposition(f.queue.get(child.id));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].description, f.calls[0][2].description);
  assert.ok(f.queue.get(child.id), 'an invalid recurrence must not create grandchildren');
  assert.equal(f.queue.list().length, 3);
  assert.match(schedule.readDecomposition(f.queue, child).lastError, /ancestor/);
  assert.equal(schedule.readDecomposition(f.queue, child).awaitingChange, true);
});

test('Reset preserves a mandatory rejected plan and cannot turn reset bookkeeping into new evidence', async t => {
  const f = setup(t, async () => { throw new planner.FailureDecompositionError('No safe smaller partition.', 'Rejected proposal', usage); });
  requireSplit(f);
  await service(f);
  const before = f.queue.get(f.task.id);
  const journal = JSON.stringify(schedule.readDecomposition(f.queue, f.task));
  f.runner.reset();
  const after = f.queue.get(f.task.id);
  assert.ok(schedule.requiresDecomposition(after));
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand',
    'output', 'validationReport', 'errorLog', 'attempts', 'startedAt']) assert.equal(after[field], before[field], field);
  assert.equal(JSON.stringify(schedule.readDecomposition(f.queue, f.task)), journal);
  f.queue.setRunState('RUNNING');
  dueNow(f);
  await f.runner.runNow();
  assert.equal(f.calls.length, 1, 'Reset is an owner control, not a new observed implementation outcome');
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
});

test('a live cron split wakes the first replacement executor without reviewing the retired parent again', async t => {
  let started, release;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const f = setup(t, undefined, { './agents': { executeTask: async (_context, _output, task) => {
    started(task);
    return new Promise(resolve => { release = resolve; });
  } } });
  requireSplit(f);
  delete f.runner.wakeAfterHandoff;
  delete f.runner.pump;
  await f.runner.runNow();
  let deadline;
  const child = await Promise.race([startedPromise, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(Error('The committed first child was not started by the live cron handoff.')), 3000);
  })]).finally(() => clearTimeout(deadline));
  assert.equal(child.title, 'Correct the enabling transition');
  assert.notEqual(child.id, f.task.id);
  assert.equal(f.queue.get(f.task.id), undefined);
  assert.equal(f.calls.length, 1, 'the retired parent gets no second replacement-planning call');
  assert.equal(f.queue.activeTask().id, child.id);
  f.runner.stop();
  release({ text: 'First replacement handoff.', usage, completion: { status: 'READY_FOR_VALIDATION' } });
  await new Promise(resolve => setTimeout(resolve, 0));
});
