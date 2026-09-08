const { test } = require('node:test');
const { assert, fixture, load } = require('./queue-progress-helpers.cjs');
const scheduler = load('src/queue/recoveryDecomposition.ts');

function setup(t) {
  const queue = fixture(t);
  const task = queue.list()[0];
  return { queue, task, job: scheduler.scheduleDecomposition(queue, task, 'An observed failure requires smaller work.') };
}

test('only a new observation gets a new allowance; revisiting exhausted inputs never resets their count', t => {
  const f = setup(t);
  for (let i = 0; i < 3; i++) assert.equal(scheduler.admitDecomposition(f.queue, f.task, f.job, 'observed-A', i * 100_000), true);
  assert.equal(scheduler.admitDecomposition(f.queue, f.task, f.job, 'observed-A', 999_999), false);
  assert.equal(scheduler.admitDecomposition(f.queue, f.task, f.job, 'observed-B', 999_999), true);
  const restored = scheduler.readDecomposition(f.queue, f.task);
  assert.equal(scheduler.admitDecomposition(f.queue, f.task, restored, 'observed-A', 9_999_999), false);
  assert.equal(restored.inputs['observed-A'], 3);
  assert.equal(restored.inputs['observed-B'], 1);
});

test('frequent ticks before the durable dueAt do not consume another planning admission', t => {
  const f = setup(t);
  assert.equal(scheduler.admitDecomposition(f.queue, f.task, f.job, 'same-input', 10_000), true);
  const dueAt = f.job.dueAt;
  assert.ok(dueAt > 10_000);
  for (let now = 10_001; now < dueAt; now += 1000) {
    assert.equal(scheduler.admitDecomposition(f.queue, f.task, f.job, 'same-input', now), false);
  }
  assert.equal(scheduler.readDecomposition(f.queue, f.task).inputs['same-input'], 1);
  assert.equal(scheduler.admitDecomposition(f.queue, f.task, f.job, 'same-input', dueAt), true);
});

test('corrupt or partial persisted accounting cannot authorize fresh provider spending', t => {
  const f = setup(t);
  const valid = { version: 1, reason: 'Observed failure.', inputs: {}, fingerprint: '', dueAt: 0,
    awaitingChange: false, lastError: '', invalidPlan: '' };
  const corruptions = ['not JSON', '{}', JSON.stringify({ ...valid, inputs: { x: -1 } }),
    JSON.stringify({ ...valid, dueAt: -1 }), JSON.stringify({ ...valid, awaitingChange: 'no' }),
    JSON.stringify({ ...valid, fingerprint: null }), JSON.stringify({ ...valid, invalidPlan: undefined }),
    JSON.stringify({ version: 1, inputs: {}, dueAt: 0, reason: 'Partially saved state.' })];
  for (const text of corruptions) {
    f.queue.setMeta(scheduler.decompositionKey(f.task), text);
    const job = scheduler.readDecomposition(f.queue, f.task);
    assert.equal(scheduler.admitDecomposition(f.queue, f.task, job, 'fresh-observation', Date.now()), false, text);
    assert.equal(job.awaitingChange, true);
  }
});

test('an unverified family has at most 32 committed-split reservations, retained across reload and Start', t => {
  const f = setup(t);
  for (let i = 0; i < 32; i++) assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), true);
  assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), false);
  f.queue.setRunState('STOPPED');
  f.queue.setRunState('RUNNING');
  const reloadedScheduler = load('src/queue/recoveryDecomposition.ts');
  assert.equal(reloadedScheduler.admitDecompositionFamily(f.queue, f.task), false);
  const unrelated = f.queue.addAll([{ title: 'Another independent goal', description: 'Must have a separate family.' }]);
  assert.equal(unrelated, 1);
  assert.equal(scheduler.admitDecompositionFamily(f.queue, f.queue.list()[1]), true);
});

test('removing and reappearing verified proof never renews a spent family split allowance', t => {
  const f = setup(t);
  const family = scheduler.decompositionFamily(f.task);
  f.queue.addAll([{ title: 'Verified family slice', description: 'Already completed behavior.' }]);
  const proof = f.queue.list()[1];
  f.queue.update(proof.id, { status: 'VERIFIED', region: JSON.stringify({ failureFamily: family }),
    validationReport: 'Current independently observed proof A.' });
  for (let i = 0; i < 32; i++) assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), true);
  assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), false);
  f.queue.update(proof.id, { status: 'PENDING' });
  assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), false, 'loss of proof is not new verified progress');
  f.queue.update(proof.id, { status: 'VERIFIED' });
  assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), false, 'the same proof returning is not new progress');
  f.queue.update(proof.id, { validationReport: 'New independently observed proof B.' });
  assert.equal(scheduler.admitDecompositionFamily(f.queue, f.task), true, 'new verified outcome evidence permits productive continuation');
});
