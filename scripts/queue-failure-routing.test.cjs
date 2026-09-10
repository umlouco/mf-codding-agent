const { test } = require('node:test');
const { assert, fixture, orchestrator, usage, load } = require('./queue-progress-helpers.cjs');
const { requiresDecomposition, readDecomposition } = load('src/queue/recoveryDecomposition.ts');
const { parseScopeAssessment } = load('src/queue/scopePlan.ts');

const family = 'inherited-failed-objective';
const familyKey = `failureDecompositionFamily:v1:${family}`;
const parts = () => ['First remaining behavior', 'Final independent observation'].map((title, index) => ({
  title, description: `Complete only ${title.toLowerCase()}, preserving earlier changes.`,
  implVerifyPrompt: `Inspect ${title.toLowerCase()}.`,
  solutionVerifyPrompt: `Exercise ${title.toLowerCase()}.`,
  solutionVerifyCommand: index === 1 ? 'npm run test:fields' : '',
}));

function setup(t, status, dependencies = {}) {
  const queue = fixture(t);
  queue.addAll([{ title: 'Unrelated later work', description: 'Retain its position and contract.' }]);
  const claimed = queue.claimNext();
  queue.update(claimed.id, { status, region: JSON.stringify({ failureFamily: family }),
    implVerifyPrompt: 'Inspect existing transition handlers.', solutionVerifyPrompt: 'Exercise both transitions.',
    solutionVerifyCommand: 'npm run test:fields', output: 'Working changes already exist; retain the executor handoff.',
    validationReport: JSON.stringify({ conclusion: 'INCOMPLETE', remaining: 'A required behavior is still unobserved.' }),
    errorLog: 'Preserve the exact preceding failed tool observation.' });
  queue.setMeta(familyKey, JSON.stringify({ proofs: [], splits: 32 }));
  const runner = orchestrator(queue, dependencies);
  return { queue, runner, task: queue.get(claimed.id), beforeIds: Array.from(queue.list(), row => row.id) };
}

function assertRefusalIsScheduled(f, reason = /verified family outcome/) {
  const current = f.queue.get(f.task.id);
  assert.ok(current, 'the failed split transaction must retain its original row');
  assert.deepEqual(Array.from(f.queue.list(), row => row.id), f.beforeIds, 'no replacement child may escape rollback');
  assert.equal(current.status, 'VERIFYING', 'a failed split must not leave its parent PENDING or EXECUTING');
  assert.equal(current.activityPhase, 'decomposition_required');
  assert.equal(requiresDecomposition(current), true);
  assert.match(readDecomposition(f.queue, current).reason, reason);
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(JSON.parse(f.queue.getMeta(familyKey)).splits, 32, 'failed admission cannot reset or increment the budget');
  for (const field of ['title', 'description', 'implVerifyPrompt', 'solutionVerifyPrompt',
    'solutionVerifyCommand', 'output', 'validationReport', 'errorLog', 'attempts', 'startedAt', 'region']) {
    assert.equal(current[field], f.task[field], `retain ${field}`);
  }
}

test('normal progress SPLIT_TASK schedules the planner without spending or resetting the family budget', async t => {
  const f = setup(t, 'EXECUTING');
  await f.runner.applyProgressDecision(f.task,
    { action: 'SPLIT_TASK', reason: 'Partition the remaining work.', splitInto: parts(), usage }, { gen: 0 });
  assertRefusalIsScheduled(f, /Partition the remaining work/);
});

test('normal supervisor SPLIT verdict preserves the family budget while requesting the planner', async t => {
  let decisions = 0;
  const f = setup(t, 'VERIFYING', { './agents': { superviseTask: async () => {
    decisions++;
    return { verdict: 'SPLIT', feedback: 'The remaining implementation and observation need separate tasks.',
      splitInto: parts(), taskEdits: [], usage };
  } } });
  await f.runner.supervise(f.task);
  assert.equal(decisions, 1, 'the normal verifier-supervisor path produced this replacement decision');
  assertRefusalIsScheduled(f, /need separate tasks/);
});

test('normal scope SPLIT family-budget refusal stops the parent without losing work or creating children', t => {
  const f = setup(t, 'EXECUTING');
  const assessment = parseScopeAssessment({ action: 'SPLIT', reason: 'Two unfinished outcomes require separate ownership.',
    execution: { shape: 'broad', reason: 'Independent remaining outcomes.' },
    verification: { shape: 'focused', reason: 'One final required check.' },
    requirements: [{ key: 'required', criterion: f.task.description }],
    parts: parts().map((part, index) => ({ ...part, key: `part-${index}`, dependsOn: [],
      covers: ['required'], integration: index === 1, handoff: f.task.output })),
  }, f.task);
  assert.equal(f.runner.applyScopeSplit(assessment, f.task, () => true), false);
  assertRefusalIsScheduled(f);
});
