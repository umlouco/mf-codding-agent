const {
  assert, test, load, prompts, validation, cognition, usage, output, notes, goal,
  task, agents, fixture, orchestrator,
} = require('./queue-progress-helpers.cjs');

function modules(run) {
  const dependencies = { './agents': { ...agents(), runOnce: run },
    './prompts': prompts, './validation': validation, './cognition': cognition };
  const requirements = load('src/queue/requirements.ts', dependencies);
  return { requirements, monitor: load('src/queue/monitor.ts', {
    ...dependencies, './requirements': {
      reviewTaskRequirements: () => assert.fail('live review must not add a preliminary requirements turn'),
    },
  }) };
}

const reply = value => ({ text: JSON.stringify(value), usage });
const correction = (current, patch = {}) => ({ compatible: false, reason: 'Correct the conflicting check.',
  description: current.description, implVerifyPrompt: current.implVerifyPrompt,
  solutionVerifyPrompt: current.solutionVerifyPrompt,
  solutionVerifyCommand: current.solutionVerifyCommand, ...patch });

test('missing and unchanged progress rewrites get one compact repair before application', async t => {
  for (const invalid of [
    { action: 'STOP_AND_REWRITE_TASK' },
    { action: 'STOP_AND_REWRITE_TASK', rewrittenDescription: `  ${task.description}\n` },
    { action: 'STOP_AND_REWRITE_VALIDATION' },
    { action: 'STOP_AND_REWRITE_VALIDATION', solutionVerifyPrompt: ` ${task.solutionVerifyPrompt} ` },
  ]) {
    const queue = fixture(t);
    queue.update(queue.list()[0].id, {
      implVerifyPrompt: task.implVerifyPrompt, solutionVerifyPrompt: task.solutionVerifyPrompt,
    });
    const current = queue.claimNext();
    queue.update(current.id, { status: 'VERIFYING', output: 'Keep the executor handoff.' });
    const snapshot = queue.get(current.id);
    let calls = 0;
    const { monitor } = modules(async (_context, _output, _role, prompt, opts) => {
      calls++;
      if (calls === 1) return reply({ ...invalid, reason: 'Wrong approach or check.' });
      assert.equal(calls, 2);
      assert.equal(opts.formatOnly, true);
      assert.equal(opts.maxIterations, 1);
      for (const text of [notes, current.description, current.implVerifyPrompt, current.solutionVerifyPrompt]) {
        assert.ok(prompt.includes(text), `repair must retain ${text}`);
      }
      for (const text of [goal, 'Latest actual tool evidence', 'Keep the executor handoff.']) {
        assert.ok(!prompt.includes(text), `format repair must not repeat the investigation: ${text}`);
      }
      assert.match(prompt, /Validation problem:/);
      assert.match(prompt, /do not switch to\s+CONTINUE_EXECUTION or START_VALIDATION/);
      assert.equal(queue.get(current.id).status, 'VERIFYING', 'nothing applied before a complete decision');
      return reply({ action: invalid.action, reason: 'Complete the required correction.',
        ...(invalid.action === 'STOP_AND_REWRITE_TASK'
          ? { rewrittenDescription: 'Test both transitions in the actual authenticated application form.' }
          : { solutionVerifyPrompt: 'Run both transitions in the actual authenticated form.' }) });
    });
    const runner = orchestrator(queue, { './monitor': monitor, './agents': agents() });
    runner.verifyWithExecutor = () => assert.fail('a rejected contract must not be verified');
    const decision = await monitor.reviewProgress({}, output, snapshot,
      [{ id: 1, at: Date.now(), actor: 'executor', kind: 'tool', message: 'Latest actual tool evidence' }],
      0, { ownerInstructions: notes, projectNotes: notes }, goal);
    await runner.applyProgressDecision(snapshot, decision, {});
    assert.equal(calls, 2);
    assert.equal(decision.usage.input, 2);
    assert.equal(queue.get(current.id).status, 'PENDING');
    assert.equal(queue.get(current.id).output, snapshot.output);
    assert.equal(queue.countEvents(current.id, 'monitor-error'), 0);
  }
});

test('checks-only corrections preserve requirements through the helper and single-pass live review', async t => {
  for (const source of ['requirements', 'progress']) for (const patch of [
    { implVerifyPrompt: 'Inspect the actual handler.' },
    { solutionVerifyPrompt: 'Test both transitions in the actual application.' },
    { solutionVerifyCommand: '' },
  ]) {
    const queue = fixture(t);
    queue.update(queue.list()[0].id, { implVerifyPrompt: task.implVerifyPrompt,
      solutionVerifyPrompt: task.solutionVerifyPrompt, solutionVerifyCommand: 'node wrong-fixture.js' });
    const current = queue.claimNext();
    let calls = 0;
    const { requirements, monitor } = modules(async (_context, _output, _role, prompt) => {
      calls++;
      assert.ok(prompt.includes(notes));
      if (source === 'requirements') {
        assert.match(prompt, /DERIVED TASK CONTRACT/);
        return reply(correction(current, { description: ` ${current.description}\n`, ...patch }));
      }
      assert.match(prompt, /You supervise a coding agent/);
      return reply({ action: 'STOP_AND_REWRITE_VALIDATION', reason: 'Correct the conflicting check.', ...patch });
    });
    const runner = orchestrator(queue, { './monitor': monitor, './agents': agents() });
    let stopped = 0;
    runner.executionAbort = () => { stopped++; };
    runner.verifyWithExecutor = () => assert.fail('do not run rejected checks');
    const decision = source === 'requirements'
      ? (await requirements.reviewTaskRequirements({}, output, current, goal, notes, {})).correction
      : await monitor.reviewProgress({}, output, current, [], 0, { ownerInstructions: notes }, goal);
    assert.equal(decision.action, 'STOP_AND_REWRITE_VALIDATION');
    await runner.applyProgressDecision(current, decision, {});
    assert.equal(calls, 1, 'no redundant progress investigation or repair');
    assert.equal(stopped, 1);
    const after = queue.get(current.id);
    assert.equal(after.description, current.description);
    assert.equal(after.status, 'PENDING');
    for (const [key, value] of Object.entries(patch)) assert.equal(after[key], value);
    assert.equal(queue.countEvents(current.id, 'task-edited'), 0);
    assert.equal(queue.countEvents(current.id, 'validation-edited'), 1);
  }
});

test('a no-op requirements correction is repaired instead of escaping to the orchestrator', async () => {
  let calls = 0;
  const { requirements } = modules(async (_context, _output, _role, prompt, opts) => {
    calls++;
    if (calls === 1) return reply(correction(task, { description: ` ${task.description} ` }));
    assert.equal(calls, 2);
    assert.equal(opts.formatOnly, true);
    assert.ok(prompt.includes(notes));
    assert.ok(prompt.includes(goal));
    assert.match(prompt, /no changed contract fields/);
    return reply(correction(task, { description: 'Test the real authenticated form, not a demonstration page.' }));
  });
  const result = await requirements.reviewTaskRequirements({}, output, task, goal, notes, {});
  assert.equal(result.correction.action, 'STOP_AND_REWRITE_TASK');
  assert.notEqual(result.correction.rewrittenDescription, task.description);
  assert.equal(result.usage.input, 2);
});

test('repeated no-op progress rewrites exhaust one repair and preserve work without verification', async t => {
  for (const path of ['task', 'validation']) {
    const queue = fixture(t);
    const current = queue.claimNext();
    queue.update(current.id, { status: 'VERIFYING', output: 'Existing work and handoff.' });
    const snapshot = queue.get(current.id);
    let calls = 0;
    const { monitor } = modules(async () => {
      calls++;
      return reply(path === 'task'
        ? { action: 'STOP_AND_REWRITE_TASK', reason: 'Wrong approach.', rewrittenDescription: snapshot.description }
        : { action: 'STOP_AND_REWRITE_VALIDATION', reason: 'Wrong checks.', solutionVerifyCommand: snapshot.solutionVerifyCommand });
    });
    const runner = orchestrator(queue, { './monitor': monitor, './agents': agents() });
    runner.verifyWithExecutor = () => assert.fail('an invalid rewrite cannot imply readiness');
    runner.stopForDecision = () => assert.fail('an invalid rewrite must not stop work');
    await runner.reviewWork(snapshot);
    assert.equal(calls, 2, 'repair is bounded');
    const after = queue.get(current.id);
    for (const key of ['status', 'description', 'output', 'attempts', 'startedAt',
      'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']) {
      assert.equal(after[key], snapshot[key], `${path}: preserve ${key}`);
    }
    assert.equal(queue.countEvents(current.id, 'monitor-error'), 1);
    assert.equal(queue.countEvents(current.id, 'action:START_VALIDATION'), 0);
  }
});

test('repeated no-op requirements corrections exhaust one repair without changing saved work', async t => {
  const queue = fixture(t);
  const current = queue.claimNext();
  queue.update(current.id, { status: 'VERIFYING', output: 'Existing work and handoff.',
    implVerifyPrompt: task.implVerifyPrompt, solutionVerifyPrompt: task.solutionVerifyPrompt });
  const snapshot = queue.get(current.id);
  let calls = 0;
  const { requirements } = modules(async () => { calls++; return reply(correction(snapshot)); });
  await assert.rejects(requirements.reviewTaskRequirements({}, output, snapshot, goal, notes, {}),
    /no changed contract fields/);
  assert.equal(calls, 2, 'the helper has one bounded repair, not a live-review preflight');
  assert.deepEqual(queue.get(current.id), snapshot);
  assert.equal(queue.countEvents(current.id, 'action:START_VALIDATION'), 0);
});

test('valid progress decisions need no repair and can remove an invalid command', async () => {
  for (const decision of [
    { action: 'CONTINUE_EXECUTION' },
    { action: 'START_VALIDATION' },
    { action: 'STOP_AND_REWRITE_TASK', rewrittenDescription: 'Corrected task with required behavior.' },
    { action: 'STOP_AND_REWRITE_VALIDATION', solutionVerifyCommand: '' },
  ]) {
    let calls = 0;
    const { monitor } = modules(async () => { calls++; return reply({ ...decision, reason: 'Current evidence.' }); });
    const result = await monitor.reviewProgress({}, output,
      { ...task, solutionVerifyCommand: 'node wrong-fixture.js' }, [], 0);
    assert.equal(calls, 1);
    assert.equal(result.action, decision.action);
    if (decision.action === 'STOP_AND_REWRITE_VALIDATION') assert.equal(result.solutionVerifyCommand, '');
  }
});
