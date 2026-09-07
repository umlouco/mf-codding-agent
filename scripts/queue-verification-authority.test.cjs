const { test } = require('node:test');
const { assert, fixture, split } = require('./queue-scope-helpers.cjs');

function setup(t, proof = {}) {
  const f = fixture(t);
  f.queue.replaceAll([{ title: 'Independent outcomes', description: 'Implement the assigned observable transitions.',
    implVerifyPrompt: 'Inspect the implementation.', solutionVerifyPrompt: 'Exercise the transitions.' }]);
  const parent = f.queue.list()[0];
  const scope = f.load('src/queue/scopePlan.ts');
  const assessment = scope.parseScopeAssessment(split(), parent);
  const archiveKey = `scopeSplit:${parent.id}:${parent.createdAt}`;
  f.queue.setMeta(archiveKey, JSON.stringify({ task: parent, assessment, archivedAt: Date.now(),
    ownerContext: JSON.stringify([f.queue.getMeta('goal'), f.queue.testingContext + f.queue.instructions]) }));
  f.queue.splitTask(parent.id, scope.replacementTasks(assessment, parent, archiveKey));
  const child = f.queue.list()[0];
  const adapter = 'generated-check --unrelated-siblings';
  const region = JSON.parse(child.region);
  region.scopeSplit.contract.solutionVerifyCommand = adapter;
  f.queue.update(child.id, { solutionVerifyCommand: adapter, region: JSON.stringify(region) });
  f.queue.log(child.id, 'supervisor', 'check-fixed', JSON.stringify({
    source: 'scoped-reverify-command', oldCommand: '', newCommand: adapter, ...proof,
  }));
  return { ...f, task: f.queue.get(child.id), adapter, archiveKey,
    authority: f.load('src/queue/verificationAuthority.ts').verificationAuthority };
}

function snapshot(queue) {
  return JSON.stringify(['tasks', 'queue_meta', 'task_events', 'agent_logs']
    .map(table => queue.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

test('host provenance identifies a generated adapter without changing any task, metadata, report or journal', t => {
  const f = setup(t);
  const before = snapshot(f.queue);
  const authority = f.authority(f.queue, f.task);
  assert.equal(authority.source, 'extension-generated');
  assert.equal(authority.originalCommand, '');
  assert.equal(authority.adapter, f.adapter);
  assert.equal(authority.eventId, f.queue.events(f.task.id, -1)[0].id);
  assert.match(authority.reason, /not an owner-authored acceptance requirement/);
  assert.match(authority.reason, /behavioral checks remain authoritative in full/);
  assert.equal(snapshot(f.queue), before, 'classification must not repair or weaken database rows');
});

test('a genuine nonempty owner command is never classified as an invented empty-check adapter', t => {
  const f = setup(t, { oldCommand: 'owner-required-check --strict' });
  assert.equal(f.authority(f.queue, f.task), undefined);
});

test('nonmatching source, prior command or current adapter is not sufficient provenance', t => {
  for (const proof of [{ source: 'model-guess' }, { oldCommand: ' ' }, { newCommand: 'different-adapter' }]) {
    const f = setup(t, proof);
    assert.equal(f.authority(f.queue, f.task), undefined);
  }
});

test('only the latest supervisor check correction can classify the current adapter', t => {
  for (const message of ['incomplete JSON', JSON.stringify({ source: 'scoped-reverify-command',
    oldCommand: 'an-existing-command', newCommand: 'generated-check --unrelated-siblings' })]) {
    const f = setup(t);
    f.queue.log(f.task.id, 'supervisor', 'check-fixed', message);
    assert.equal(f.authority(f.queue, f.task), undefined, 'must not skip a newer correction to resurrect older provenance');
  }
});

test('later user contract changes revoke generated-adapter classification even if the same command remains', t => {
  for (const kind of ['task-edited', 'contract-edited', 'task-updated', 'validation-edited', 'check-fixed']) {
    const f = setup(t);
    f.queue.log(f.task.id, 'user', kind, 'Owner explicitly changed this contract.');
    assert.equal(f.authority(f.queue, f.task), undefined);
  }
});

test('all four assigned contract fields must still exactly match the admitted local assignment', t => {
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']) {
    const f = setup(t);
    f.queue.update(f.task.id, { [field]: f.task[field] + ' Owner modification.' });
    assert.equal(f.authority(f.queue, f.queue.get(f.task.id)), undefined);
  }
});

test('missing split evidence, integration gates and changed owner context cannot authorize adapter reinterpretation', t => {
  for (const change of ['archive', 'integration', 'owner']) {
    const f = setup(t);
    if (change === 'archive') f.queue.setMeta(f.archiveKey, '');
    else if (change === 'owner') f.queue.setMeta('goal', 'The owner supplied a different goal.');
    else {
      const region = JSON.parse(f.task.region);
      region.scopeSplit.integration = true;
      f.queue.update(f.task.id, { region: JSON.stringify(region) });
    }
    assert.equal(f.authority(f.queue, f.queue.get(f.task.id)), undefined);
  }
});

test('ordinary user activity and old user edits do not impersonate a later contract change', t => {
  const f = setup(t);
  f.queue.log(f.task.id, 'user', 'viewed', 'Opened the task detail.');
  assert.equal(f.authority(f.queue, f.task).source, 'extension-generated');
});

function correction(f, command, oldCommand = f.queue.get(f.task.id).solutionVerifyCommand) {
  const current = f.queue.get(f.task.id);
  const region = JSON.parse(current.region);
  region.scopeSplit.contract.solutionVerifyCommand = command;
  f.queue.update(current.id, { solutionVerifyCommand: command, region: JSON.stringify(region) });
  f.queue.log(current.id, 'supervisor', 'check-fixed', JSON.stringify({
    source: 'scoped-reverify-command', oldCommand, newCommand: command,
  }));
  return f.queue.get(current.id);
}

test('an exact sequence of generated adapter corrections retains its original empty-command provenance', t => {
  const f = setup(t);
  const originId = f.queue.events(f.task.id, -1)[0].id;
  correction(f, 'second-generated-adapter');
  const current = correction(f, 'third-generated-adapter');
  const latestId = f.queue.events(f.task.id, -1)[0].id;
  const before = snapshot(f.queue);
  const authority = f.authority(f.queue, current);
  assert.equal(authority.source, 'extension-generated');
  assert.equal(authority.originalCommand, '');
  assert.equal(authority.adapter, 'third-generated-adapter');
  assert.equal(authority.eventId, latestId);
  assert.equal(authority.originEventId, originId);
  assert.equal(snapshot(f.queue), before);
});

test('adapter chains reject owner-authored roots, intervening owner edits, malformed links and unmatched branches', t => {
  for (const invalid of ['owner-root', 'owner-edit', 'malformed', 'branch']) {
    const f = setup(t, invalid === 'owner-root' ? { oldCommand: 'owner-required-check' } : {});
    if (invalid === 'owner-edit') f.queue.log(f.task.id, 'user', 'contract-edited', 'The owner assumed authority over this check.');
    if (invalid === 'malformed') f.queue.log(f.task.id, 'supervisor', 'check-fixed', 'unparseable correction');
    const current = correction(f, 'latest-generated-adapter', invalid === 'branch' ? 'an-unproven-adapter' : undefined);
    assert.equal(f.authority(f.queue, current), undefined, invalid);
  }
});
