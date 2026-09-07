const { test } = require('node:test');
const { assert, fixture, split } = require('./queue-scope-helpers.cjs');

function admitted(t, persist = false) {
  const f = fixture(t);
  const parent = f.queue.list()[0];
  const scope = f.load('src/queue/scopePlan.ts');
  const assessment = scope.parseScopeAssessment(split(), parent);
  const archiveKey = `scopeSplit:${parent.id}:${parent.createdAt}`;
  f.queue.setMeta(archiveKey, JSON.stringify({ task: parent, assessment, archivedAt: Date.now(),
    ownerContext: JSON.stringify([f.queue.getMeta('goal'), f.queue.testingContext + f.queue.instructions]) }));
  const parts = scope.replacementTasks(assessment, parent, archiveKey);
  if (persist) for (const part of parts) {
    const region = JSON.parse(part.region);
    region.scopeSplit.contract = Object.fromEntries(['description', 'implVerifyPrompt',
      'solutionVerifyPrompt', 'solutionVerifyCommand'].map(key => [key, part[key]]));
    part.region = JSON.stringify(region);
  }
  f.queue.splitTask(parent.id, parts);
  const task = f.queue.list()[0];
  return { ...f, api: f.load('src/queue/scopeContract.ts'), task, archiveKey };
}

function automatedRewrite(f, overrides = {}) {
  const contract = { description: 'Finish the entire original objective, including all sibling tasks.',
    implVerifyPrompt: 'Inspect every unit.', solutionVerifyPrompt: 'Test every unit.',
    solutionVerifyCommand: '', ...overrides };
  const reason = 'The local prerequisite must implement the whole owner request.';
  const response = JSON.stringify({ compatible: false, reason, ...contract });
  // Real response streams can split a JSON string between arbitrary chunks.
  f.queue.appendLog(f.task.id, 'supervisor', 'response', response.slice(0, 47));
  f.queue.appendLog(f.task.id, 'supervisor', 'response', response.slice(47));
  f.queue.log(f.task.id, 'supervisor', 'action:STOP_AND_REWRITE_TASK', reason);
  f.queue.update(f.task.id, { ...contract, status: 'VERIFYING', attempts: 3, output: 'Existing changes and handoff.',
    validationReport: 'Evidence gathered against the superseded broad contract.', errorLog: 'Existing failure evidence.' });
  f.queue.log(f.task.id, 'supervisor', 'task-edited', contract.description);
  return f.queue.get(f.task.id);
}

test('admitted local contracts retain exact old replacement text and exclude final acceptance', t => {
  const f = admitted(t);
  const result = f.api.scopedContract(f.queue, f.task);
  assert.equal(result.contract.description, f.task.description);
  assert.equal(result.contract.solutionVerifyPrompt, f.task.solutionVerifyPrompt);
  assert.equal(f.api.isLocalScope(f.task), true);
  assert.equal(f.api.hasAdmittedScope(f.queue, f.task), true);
  const gate = f.queue.list().find(task => JSON.parse(task.region || '{}').scopeSplit?.integration);
  assert.equal(f.api.scopedContract(f.queue, gate), undefined);
  assert.equal(f.api.isLocalScope(gate), false);
  assert.equal(f.api.hasAdmittedScope(f.queue, gate), true);
});

test('explicit Start reconciliation restores proven automatic drift and archives all prior evidence', t => {
  const f = admitted(t);
  const before = automatedRewrite(f);
  assert.equal(f.api.restoreScopedContracts(f.queue), 1);
  const after = f.queue.get(f.task.id);
  for (const field of f.api.scopeContractFields) assert.equal(after[field], f.task[field]);
  for (const field of ['status', 'attempts', 'output', 'errorLog', 'startedAt']) assert.equal(after[field], before[field]);
  assert.equal(after.validationReport, '');
  const event = f.queue.events(f.task.id, -1).find(event => event.kind === 'scope-contract-restored');
  const archive = JSON.parse(f.queue.getMeta(JSON.parse(event.message).archiveKey));
  assert.equal(archive.task.validationReport, before.validationReport);
  assert.equal(archive.task.supervisorFeedback, before.supervisorFeedback);
  assert.equal(f.api.restoreScopedContracts(f.queue), 0, 'repair is idempotent');
});

test('manual edits without old user journal entries cannot be inferred to be automated drift', t => {
  const f = admitted(t);
  automatedRewrite(f);
  f.queue.update(f.task.id, { solutionVerifyPrompt: 'Owner-selected revised local acceptance.' });
  const before = f.queue.get(f.task.id);
  assert.equal(f.api.restoreScopedContracts(f.queue), 0);
  assert.deepEqual(f.queue.get(f.task.id), before);
});

test('a known owner contract edit prevents archive rollback even when model text matches', t => {
  const f = admitted(t);
  automatedRewrite(f);
  f.queue.log(f.task.id, 'user', 'task-edited', 'Owner updated this contract.');
  assert.equal(f.api.restoreScopedContracts(f.queue), 0);
});

test('a rewrite marker without complete exact model fields cannot authorize restoration', t => {
  const f = admitted(t);
  f.queue.update(f.task.id, { description: 'A possibly owner-edited task.' });
  f.queue.log(f.task.id, 'supervisor', 'action:STOP_AND_REWRITE_TASK', 'A broad-scope correction.');
  f.queue.log(f.task.id, 'supervisor', 'task-edited', 'A possibly owner-edited task.');
  assert.equal(f.api.restoreScopedContracts(f.queue), 0);
  assert.equal(f.api.hasAdmittedScope(f.queue, f.queue.get(f.task.id)), false);
});

test('abandoned malformed response chunks do not obscure a later complete rewrite proof', t => {
  const f = admitted(t);
  f.queue.appendLog(f.task.id, 'supervisor', 'response', '{"compatible": false, "description": "abandoned');
  automatedRewrite(f);
  assert.equal(f.api.restoreScopedContracts(f.queue), 1);
});

test('completed and executing work is not modified by Start reconciliation', t => {
  const f = admitted(t, true);
  automatedRewrite(f);
  for (const status of ['VERIFIED', 'EXECUTING']) {
    f.queue.update(f.task.id, { status });
    assert.equal(f.api.restoreScopedContracts(f.queue), 0);
  }
});

test('missing archives, changed owner instructions, and malformed allocation are not admission evidence', t => {
  const f = admitted(t, true);
  assert.ok(f.api.scopedContract(f.queue, f.task));
  assert.equal(f.api.hasAdmittedScope(f.queue, f.task), true);
  const archive = JSON.parse(f.queue.getMeta(f.archiveKey));
  f.queue.setMeta(f.archiveKey, JSON.stringify({ ...archive, ownerContext: 'Different owner context' }));
  assert.equal(f.api.scopedContract(f.queue, f.task), undefined);
  assert.equal(f.api.hasAdmittedScope(f.queue, f.task), false);
  f.queue.setMeta(f.archiveKey, '');
  assert.equal(f.api.scopedContract(f.queue, f.task), undefined);
  assert.equal(f.api.hasAdmittedScope(f.queue, f.task), false);
  assert.equal(f.api.isLocalScope({ ...f.task, region: '{"scopeSplit":{}}' }), false);
  assert.equal(f.api.hasAdmittedScope(f.queue, { ...f.task, region: '{"scopeSplit":{}}' }), false);
});
