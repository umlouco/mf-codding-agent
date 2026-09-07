const { test } = require('node:test');
const { assert, fixture, usage, drain } = require('./queue-scope-helpers.cjs');

function setup(t, expandPhase) {
  const f = fixture(t, { expandPhase, executeTask: async () => assert.fail('Later work must not bypass unfinished phase expansion.') });
  f.queue.replaceAll([{ title: 'Original phase', description: 'Discover the assigned independent outcomes.', kind: 'phase',
    region: JSON.stringify({ paths: ['src'], fileCount: 4 }) }, { title: 'Later work', description: 'Depends on the phase.' }]);
  f.queue.setRunState('RUNNING');
  f.task = f.queue.list()[0];
  f.schedule = f.load('src/queue/recoverySchedule.ts');
  Object.defineProperty(f.runner, 'mode', { value: 'continuous', configurable: true });
  f.runner.resplitPhaseRegion = async () => [];
  return f;
}

test('failed and empty phase expansions schedule diagnosis rather than immediately spinning the continuous pump', async t => {
  for (const failure of ['provider', 'empty', 'cut-off']) {
    let calls = 0;
    const f = setup(t, async () => {
      calls++;
      if (failure === 'provider') throw Error('Provider unavailable.');
      return { tasks: [], splitRequests: [], usage, cutOff: failure === 'cut-off' };
    });
    await f.runner.pump();
    await drain();
    const phase = f.queue.get(f.task.id);
    assert.equal(calls, 1);
    assert.equal(phase.kind, 'phase');
    assert.equal(phase.status, 'VERIFYING');
    assert.equal(phase.attempts, 1);
    assert.equal(phase.description, f.task.description);
    assert.equal(f.schedule.readRecoveryJob(f.queue, phase).active, true);
    assert.equal(f.queue.list()[1].status, 'PENDING');
    assert.equal(f.queue.runState, 'RUNNING');
    await f.runner.pump();
    assert.equal(calls, 1, 'watchdog/pump nudges cannot relaunch unchanged expansion or later work');
  }
});

test('a changed phase-recovery approach returns to expansion and retires the phase only after concrete children commit', async t => {
  let calls = 0, secondTask;
  const f = setup(t, async (_context, _output, phase) => {
    if (++calls === 1) throw Error('The original scan did not produce a usable task list.');
    secondTask = phase;
    return { tasks: [{ title: 'Concrete outcome', description: 'Implement the discovered behavior.' }],
      splitRequests: [], usage, cutOff: false };
  });
  // Avoid launching the children while inspecting the committed phase replacement.
  Object.defineProperty(f.runner, 'mode', { value: 'lockstep', configurable: true });
  await f.runner.pump();
  assert.ok(f.queue.get(f.task.id));
  f.setReply({ action: 'EXECUTE', reason: 'The original scan chose an unavailable path.',
    guidance: 'Inspect the existing source directory, then expand only its remaining outcomes.',
    nextOperation: { tool: 'list_directory', input: { path: 'src' } } });
  await f.runner.serviceRecovery(f.queue.get(f.task.id));
  assert.equal(f.queue.get(f.task.id).kind, 'phase');
  assert.equal(f.queue.get(f.task.id).status, 'PENDING');
  await f.runner.pump();
  assert.equal(calls, 2);
  assert.match(secondTask.supervisorFeedback, /Inspect the existing source directory/);
  assert.equal(secondTask.attempts, 2);
  assert.equal(f.queue.get(f.task.id), undefined);
  assert.deepEqual(f.queue.list().map(task => task.title), ['Concrete outcome', 'Later work']);
  assert.equal(f.queue.runState, 'RUNNING');
});

test('a vanished phase worker is fenced and scheduled without an automatic pause or unchanged restart', async t => {
  let settle, cancelled = 0;
  const f = setup(t, async (_context, _output, _phase, _goal, _activity, _event, abort) => {
    abort(() => { cancelled++; });
    return new Promise(resolve => { settle = resolve; });
  });
  const pending = f.runner.pump();
  await drain();
  f.queue.db.prepare('UPDATE tasks SET last_activity_at = 1 WHERE id = ?').run(f.task.id);
  f.runner.sweepSilentWorkers();
  assert.equal(cancelled, 1);
  assert.equal(f.queue.get(f.task.id).status, 'VERIFYING');
  assert.equal(f.schedule.readRecoveryJob(f.queue, f.task).active, true);
  settle({ tasks: [{ title: 'Stale late child', description: 'Must not be committed.' }], splitRequests: [], usage, cutOff: false });
  await pending;
  assert.ok(f.queue.get(f.task.id));
  assert.equal(f.queue.list().length, 2);
  assert.equal(f.queue.runState, 'RUNNING');
});
