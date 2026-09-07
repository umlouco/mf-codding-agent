const { test } = require('node:test');
const { assert, fixture, split, keep, usage, drain } = require('./queue-scope-helpers.cjs');

function commitSplit(f) {
  const original = f.queue.claimNext();
  const { parseScopeAssessment } = f.load('src/queue/scopePlan.ts');
  assert.equal(f.runner.applyScopeSplit(parseScopeAssessment(split(), original), original, () => true), true);
  assert.equal(f.queue.get(original.id), undefined);
  return f.queue.list()[0];
}

test('requirements comparison cannot reintroduce a retired parent inside its local child', async t => {
  const f = fixture(t, { runOnce: () => assert.fail('Do not re-author a committed child against the whole owner request') });
  const child = commitSplit(f);
  const before = f.queue.get(child.id);
  const { reviewTaskRequirements } = f.load('src/queue/requirements.ts');
  const result = await reviewTaskRequirements({}, {}, child, 'Migrate all interfaces everywhere',
    'Use the actual owner runtime', {});
  assert.equal(result.correction, undefined);
  assert.equal(result.usage.input + result.usage.output, 0);
  assert.deepEqual(f.queue.get(child.id), before);
  const saved = JSON.parse(child.region).scopeSplit.contract;
  for (const field of Object.keys(saved)) assert.equal(saved[field], child[field]);
});

test('a scope-expanding progress response must be repaired, never applied to a child', async t => {
  const prompts = [];
  const f = fixture(t, { runOnce: async (_, __, ___, prompt) => {
    prompts.push(prompt);
    return { text: JSON.stringify(prompts.length === 1
      ? { action: 'STOP_AND_REWRITE_VALIDATION', reason: 'Require every sibling here',
        solutionVerifyPrompt: 'Verify all interfaces throughout the entire project.' }
      : { action: 'START_VALIDATION', reason: 'Check this assigned outcome only.' }), usage };
  } });
  const child = commitSplit(f);
  const { reviewProgress } = f.load('src/queue/monitor.ts');
  const decision = await reviewProgress({}, {}, child, [], 0,
    { ownerInstructions: 'Use the actual owner runtime' }, 'Migrate all interfaces');
  assert.equal(prompts.length, 2, 'one progress call and one repair; no whole-owner contract rewrite');
  assert.equal(decision.action, 'START_VALIDATION');
  assert.match(prompts[1], /fixed acceptance requirements/);
  assert.equal(f.queue.get(child.id).solutionVerifyPrompt, child.solutionVerifyPrompt);
});

test('host rejects direct automatic child contract mutation even when the parser is bypassed', async t => {
  const f = fixture(t);
  const child = commitSplit(f);
  f.queue.update(child.id, { status: 'VERIFYING' });
  const current = f.queue.get(child.id);
  for (const action of ['STOP_AND_REWRITE_TASK', 'STOP_AND_REWRITE_VALIDATION']) {
    await assert.rejects(() => f.runner.applyProgressDecision(current, { action,
      reason: 'Absorb every sibling', rewrittenDescription: 'Do the complete parent project again',
      solutionVerifyPrompt: 'Check all sibling outcomes', usage }, { gen: 0 }), /accepted scope/);
    assert.deepEqual(f.queue.get(child.id), current);
  }
});

test('real pump and review lifecycle verifies the first child and starts the next without recreating the parent', async t => {
  const started = [], validated = [], reviewPrompts = [];
  let phase = 'split';
  const f = fixture(t, {
    runOnce: async (_, __, ___, prompt) => {
      reviewPrompts.push(prompt);
      assert.doesNotMatch(prompt, /^Review the task contract below against/);
      const response = prompt.includes('You supervise a coding agent')
        ? { action: 'START_VALIDATION', reason: 'Its local implementation is ready.' }
        : phase === 'split' ? split() : keep();
      return { text: JSON.stringify(response), usage };
    },
    executeTask: async (_, __, task) => {
      started.push(task.id);
      return { text: 'Local implementation ready for review.', notes: '', usage,
        completion: { status: 'NEEDS_MORE_WORK' } };
    },
    superviseTask: async () => ({ verdict: 'VERIFIED', feedback: 'Independent local evidence passed.', usage }),
  }, { './verification': { runVerification: async (_, __, task) => {
    validated.push(task.id);
    return { text: 'Observed local checks passed.', validationReport: 'Local independent PASS evidence', usage };
  } } });
  f.queue.setInstructions('Use the owner application and do not weaken acceptance.');
  const originalId = f.queue.list()[0].id;
  await f.runner.pump();
  phase = 'children';
  const children = f.queue.list();
  const count = children.length;
  await f.runner.pump();
  await f.runner.runNow();
  await drain();
  assert.deepEqual(started, [children[0].id, children[1].id]);
  assert.deepEqual(validated, [children[0].id]);
  assert.equal(f.queue.get(children[0].id).status, 'VERIFIED');
  assert.equal(f.queue.get(originalId), undefined);
  assert.equal(f.queue.list().length, count, 'no recursive parent recreation');
  assert.equal(f.queue.runState, 'RUNNING');
});
