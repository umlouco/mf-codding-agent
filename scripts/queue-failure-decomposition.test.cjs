const { test } = require('node:test');
const { assert, loader, usage } = require('./queue-scope-helpers.cjs');

const task = {
  id: 45, seq: 45, title: 'Deliver the account editor',
  description: 'Correct the account editor update behavior and independently verify saved changes.',
  implVerifyPrompt: 'Inspect the account update handler and its failure handling.',
  solutionVerifyPrompt: 'Save changed account data and confirm it survives a reload.',
  solutionVerifyCommand: 'npm run test:accounts',
  output: 'The update handler exists; the new field has not yet been exercised.',
  splitScope: 'Account editor only; unrelated screens belong to other tasks.',
};
const fields = ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand'];
const input = {
  goal: 'Implement the owner-requested account management experience without losing existing behavior.',
  ownerInstructions: 'Use the supplied deployed environment and preserve all required assertions.',
  evidence: 'supervisor test repair cannot rewrite application file src/account-editor.ts; return an implementation repair decision',
  handoff: 'Existing account update work is saved; the rejected edit did not run.',
};
const moduleWith = runOnce => loader({ './agents': { extractJson: text => JSON.parse(text), runOnce } })
  ('src/queue/failureDecomposition.ts');
const api = moduleWith(() => assert.fail('the parser must not invoke a model'));

function plan(current = task) {
  return {
    verdict: 'SPLIT', feedback: 'The rejected edit used the test-repair role for application work; separate the implementation and its independent check.',
    remainingOutcomes: [
      { id: 'implementation', description: 'The existing account handler saves the new field correctly.' },
      { id: 'observation', description: 'A fresh reload independently confirms the persisted field.' },
    ],
    coverage: fields.filter(field => current[field]).map(field => ({ field, requirement: current[field],
      outcomeIds: field === 'implVerifyPrompt' ? ['implementation'] : ['implementation', 'observation'] })),
    splitInto: [
      { title: 'Correct field persistence', description: 'Executor: inspect the saved account handler and correct the observed persistence defect, retaining unrelated completed changes.',
        implVerifyPrompt: 'Inspect the narrow field persistence branch.',
        solutionVerifyPrompt: 'Exercise a field update through the account handler.',
        solutionVerifyCommand: '', outcomeIds: ['implementation'] },
      { title: 'Verify persisted account field', description: 'Use the implementation handoff to run the existing account checks and confirm the updated field survives a fresh reload; do not redo the implementation.',
        implVerifyPrompt: 'Inspect the implementation handoff and existing account checks.',
        solutionVerifyPrompt: current.solutionVerifyPrompt,
        solutionVerifyCommand: current.solutionVerifyCommand, outcomeIds: ['observation'] },
    ], taskEdits: [],
  };
}
const parse = value => api.parseFailureDecomposition(JSON.stringify(value), task);

test('failure decomposition admits complete smaller outcome owners and keeps exact acceptance coverage', () => {
  const before = JSON.stringify(task);
  const result = api.parseFailureDecomposition(JSON.stringify(plan()), task, [], usage);
  assert.equal(result.verdict, 'SPLIT');
  assert.equal(result.splitInto.length, 2);
  assert.equal(result.splitInto[1].solutionVerifyCommand, task.solutionVerifyCommand);
  assert.equal(JSON.stringify(result.decomposition.assignments), JSON.stringify([['implementation'], ['observation']]));
  assert.equal(result.decomposition.coverage.length, 4);
  assert.equal(result.usage.input, usage.input);
  assert.equal(result.taskEdits.length, 0);
  assert.equal(JSON.stringify(task), before, 'planning cannot mutate the parent');
});

test('failure decomposition has no FAIL, retry, reset, success, or parent-edit escape', () => {
  for (const verdict of ['FAIL', 'FAILED', 'RETRY', 'REVERIFY', 'VERIFIED', 'REPAIR_TESTS', 'WAIT']) {
    assert.throws(() => parse({ ...plan(), verdict }), /requires SPLIT/);
  }
  assert.throws(() => parse({ ...plan(), taskEdits: [{ seq: task.seq, description: 'Simplify acceptance' }] }), /cannot edit/);
  assert.throws(() => parse({ ...plan(), resetFromSeq: 1 }), /cannot reset/);
  assert.throws(() => parse({ ...plan(), feedback: ' ' }), /observed diagnosis/);
});

test('every replacement must be complete and at least two replacements must survive validation', () => {
  for (const field of ['title', ...fields]) {
    const invalid = plan();
    delete invalid.splitInto[1][field];
    assert.throws(() => parse(invalid), /missing|explicit verification command/);
  }
  assert.throws(() => parse({ ...plan(), splitInto: [plan().splitInto[0]] }), /at least two/);
  const invalid = plan();
  invalid.splitInto[1].solutionVerifyCommand = 'npm run test:smaller';
  assert.throws(() => parse(invalid), /retain the original required verification command/);
});

test('a new title or punctuation cannot recreate the failed parent or a retired ancestor', () => {
  const invalid = plan();
  invalid.splitInto[0].description = task.description.toUpperCase().replace(/ /g, '\n');
  assert.throws(() => parse(invalid), /repeats the parent/);
  const ancestor = { ...task, description: 'Finish every remaining screen and its application behavior.' };
  invalid.splitInto[0].description = `  ${ancestor.description.toUpperCase()}!! `;
  assert.throws(() => api.parseFailureDecomposition(JSON.stringify(invalid), task, [ancestor]), /ancestor/);
  assert.equal(api.failureScopeFingerprint(ancestor), api.failureScopeFingerprint(invalid.splitInto[0]));
});

test('siblings with duplicate descriptions or cosmetically renamed titles are rejected', () => {
  const invalid = plan();
  invalid.splitInto[1].description = ` ${invalid.splitInto[0].description.toUpperCase()}!! `;
  assert.throws(() => parse(invalid), /another child/);
  const sameTitle = plan();
  sameTitle.splitInto[1].title = ` ${sameTitle.splitInto[0].title.toUpperCase()}! `;
  assert.throws(() => parse(sameTitle), /distinct descriptive titles/);
});

test('host handoff provenance cannot disguise recreation of a retired scope', () => {
  for (const suffix of [
    '\n\nProgress-preserving handoff from retired task 18: Archived metadata scopeSplit:18.',
    '\r\n\r\nParent acceptance criteria (apply only to this assigned slice):\r\nKeep behavior.\r\n\r\nProgress-preserving handoff from task 18:',
  ]) {
    const invalid = plan();
    invalid.splitInto[0].description = task.description;
    const decorated = { ...task, description: task.description + suffix };
    invalid.coverage.find(entry => entry.field === 'description').requirement = decorated.description;
    assert.throws(() => api.parseFailureDecomposition(JSON.stringify(invalid), decorated), /repeats the parent/);
    assert.equal(api.failureScopeFingerprint(task), api.failureScopeFingerprint(decorated));
    assert.equal(api.failureScopeFingerprint(task), api.failureScopeFingerprint({ description: decorated.description.toUpperCase() }));
  }
});

test('splitting requires a genuine structural partition, not giving all work to another parent', () => {
  const invalid = plan();
  invalid.splitInto[0].outcomeIds = ['implementation', 'observation'];
  assert.throws(() => parse(invalid), /entire parent scope/);
  const overlapping = plan();
  overlapping.splitInto[1].outcomeIds = ['implementation'];
  assert.throws(() => parse(overlapping), /assigned to multiple children/);
  const omitted = plan();
  omitted.remainingOutcomes.push({ id: 'third', description: 'Handle an observed save rejection without losing entered data.' });
  assert.throws(() => parse(omitted), /omit unfinished outcomes/);
});

test('remaining outcomes must be concrete, distinct, and explicitly owned', () => {
  assert.throws(() => parse({ ...plan(), remainingOutcomes: [] }), /at least two/);
  for (const patch of [
    { id: 'implementation' },
    { id: 'observation', description: ' ' },
    { id: 'observation', description: plan().remainingOutcomes[0].description.toUpperCase() },
  ]) {
    const invalid = plan();
    invalid.remainingOutcomes[1] = patch;
    assert.throws(() => parse(invalid), /concrete unfinished|must be distinct/);
  }
  for (const ids of [[], ['unknown'], ['implementation', 'implementation']]) {
    const invalid = plan();
    invalid.splitInto[0].outcomeIds = ids;
    assert.throws(() => parse(invalid), /distinct existing outcomeIds/);
  }
});

test('coverage cannot drop, paraphrase, replace, or duplicate original acceptance fields', () => {
  assert.throws(() => parse({ ...plan(), coverage: undefined }), /coverage map/);
  const missing = plan();
  missing.coverage.pop();
  assert.throws(() => parse(missing), /drops original acceptance/);
  for (const patch of [
    { requirement: 'A weaker acceptance criterion.' },
    { field: 'inventedRequirement' },
    { outcomeIds: ['nonexistent'] },
  ]) {
    const invalid = plan();
    Object.assign(invalid.coverage[0], patch);
    assert.throws(() => parse(invalid), /Coverage must retain|distinct existing outcomeIds/);
  }
  const duplicate = plan();
  duplicate.coverage.push(duplicate.coverage[0]);
  assert.throws(() => parse(duplicate), /without substitutions or duplicates/);
});

test('every declared outcome must serve existing requirements rather than inventing unrelated work', () => {
  const invalid = plan();
  invalid.coverage.forEach(entry => { entry.outcomeIds = ['implementation']; });
  assert.throws(() => parse(invalid), /must serve an original requirement/);
});

test('an empty saved command need not be invented to split a task', () => {
  const current = { ...task, solutionVerifyCommand: '' };
  const result = api.parseFailureDecomposition(JSON.stringify(plan(current)), current);
  assert.equal(result.decomposition.coverage.length, 3);
  assert.ok(result.splitInto.every(part => part.solutionVerifyCommand === ''));
});

test('the supervisor gets the original planner prompt, owner instructions, exact tool rejection, and handoff', async () => {
  const calls = [];
  const module = moduleWith(async (...args) => {
    calls.push(args);
    return { text: JSON.stringify(plan()), usage };
  });
  const result = await module.decideFailureDecomposition({}, {}, task,
    { ...input, previousInvalidPlan: 'Earlier rejected proposal.', previousError: 'It duplicated all work.' },
    { maxIterations: -1, allowTestEdits: true });
  assert.equal(calls.length, 1);
  const [, , role, prompt, opts] = calls[0];
  assert.equal(role, 'supervisor');
  assert.equal(opts.formatOnly, true);
  assert.equal(opts.maxIterations, 1);
  assert.equal(opts.allowTestEdits, false, 'planning never inherits editing permissions');
  for (const text of [...Object.values(input), task.description, task.splitScope,
    'Earlier rejected proposal.', 'It duplicated all work.']) assert.ok(prompt.includes(text), text);
  assert.match(prompt, /DELETES the original executable row/);
  assert.match(prompt, /Application changes belong to an executor implementation task/);
  assert.match(prompt, /not by itself evidence of an application defect/);
  assert.match(prompt, /Unfinished siblings are not defects/);
  assert.equal(result.usage.input, 1);
});

test('one malformed plan gets exactly one evidence-preserving repair, then returns a complete split', async () => {
  const calls = [];
  const module = moduleWith(async (...args) => {
    calls.push(args);
    return { text: JSON.stringify(calls.length === 1 ? { ...plan(), verdict: 'RETRY' } : plan()), usage };
  });
  const result = await module.decideFailureDecomposition({}, {}, task, input);
  assert.equal(calls.length, 2);
  const repairPrompt = calls[1][3];
  assert.match(repairPrompt, /ONE FINAL PLAN REPAIR/);
  assert.match(repairPrompt, /requires SPLIT/);
  for (const text of Object.values(input)) assert.ok(repairPrompt.includes(text));
  assert.match(repairPrompt, /host has made no queue changes/);
  assert.equal(calls[1][4].maxIterations, 1);
  assert.equal(calls[1][4].formatOnly, true);
  assert.equal(result.usage.input, 2);
});

test('repeated invalid decomposition exhausts the bounded repair and exposes cost and rejected plan', async () => {
  let calls = 0;
  const invalidPlan = JSON.stringify({ ...plan(), splitInto: [] });
  const module = moduleWith(async () => { calls++; return { text: invalidPlan, usage }; });
  await assert.rejects(() => module.decideFailureDecomposition({}, {}, task, input), error => {
    assert.equal(error.invalidDecomposition, true);
    assert.equal(error.invalidPlan, invalidPlan);
    assert.equal(error.usage.input, 2);
    assert.match(error.message, /No safe failure decomposition after one repair/);
    return true;
  });
  assert.equal(calls, 2, 'no nested retries, fallback execution, or recursive split');
});

test('repair transport errors retain the cost already spent, without another hidden model call', async () => {
  let calls = 0;
  const module = moduleWith(async () => {
    calls++;
    if (calls === 1) return { text: '{}', usage };
    throw Object.assign(Error('provider unavailable'), { usage });
  });
  await assert.rejects(() => module.decideFailureDecomposition({}, {}, task, input), error => {
    assert.match(error.message, /provider unavailable/);
    assert.equal(error.usage.input, 2);
    assert.equal(error.invalidDecomposition, undefined, 'transport is not a bad-plan diagnosis');
    return true;
  });
  assert.equal(calls, 2);
});
