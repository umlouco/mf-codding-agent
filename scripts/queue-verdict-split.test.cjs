const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const child = title => ({ title, description: `Finish only ${title}; preserve existing implementation.`,
  implVerifyPrompt: `Inspect ${title}.`, solutionVerifyPrompt: `Exercise ${title}.`, solutionVerifyCommand: '' });
const decision = parts => ({ verdict: 'SPLIT', feedback: 'These are independent remaining outcomes.',
  splitInto: parts, taskEdits: [], usage });

function setup(t, parts, overrides = {}) {
  const reply = decision(parts);
  const f = fixture(t, { superviseTask: async () => reply, ...overrides });
  const original = f.queue.claimNext();
  f.queue.update(original.id, { status: 'VERIFYING', output: 'Existing shared changes must remain.',
    validationReport: 'The shared implementation is sound; independent checks remain.',
    errorLog: 'Retained earlier attempt evidence.' });
  f.queue.log(original.id, 'executor', 'tool', 'Saved a useful completed observation.');
  return { ...f, original: f.queue.get(original.id), reply };
}

test('real supervisor SPLIT commits supplied children and retires the parent without another planning turn', async t => {
  const executed = [];
  const f = setup(t, [child('First outcome'), child('Second outcome')], {
    executeTask: async (_, __, task) => {
      executed.push(task.title);
      return { text: 'First outcome complete', notes: '', usage,
        completion: { status: 'READY_FOR_VALIDATION' } };
    },
  });
  const originalUsage = { input: 9, output: 5, cacheRead: 3, cacheWrite: 2 };
  f.queue.addUsage(f.original.id, originalUsage);
  await f.runner.supervise(f.original);
  const rows = f.queue.list();
  assert.equal(f.queue.get(f.original.id), undefined);
  assert.deepEqual(rows.map(row => row.title), ['First outcome', 'Second outcome', 'Later work']);
  assert.ok(rows.every(row => row.status === 'PENDING'));
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.calls.length, 0, 'the accepted decision must not be reconsidered by another paid planner');
  const archive = JSON.parse(f.queue.getMeta(JSON.parse(rows[0].region).scopeSplit.archiveKey));
  assert.equal(archive.ownerContext, JSON.stringify([f.queue.getMeta('goal'), f.queue.testingContext + f.queue.instructions]));
  const assigned = JSON.parse(rows[0].region).scopeSplit.contract;
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']) {
    assert.equal(assigned[field], rows[0][field]);
  }
  assert.equal(archive.task.description, f.original.description);
  assert.equal(archive.task.output, f.original.output);
  assert.equal(archive.task.validationReport, f.original.validationReport);
  assert.equal(archive.task.errorLog, f.original.errorLog);
  assert.deepEqual(archive.decision.splitInto, plain(f.reply.splitInto));
  assert.ok(archive.events.some(event => event.kind === 'tool'));
  assert.deepEqual(plain(f.queue.stats().usage), { input: 10, output: 6, cacheRead: 3, cacheWrite: 2 });
  await f.runner.pump();
  assert.deepEqual(executed, ['First outcome']);
  assert.equal(f.queue.get(rows[0].id).status, 'VERIFYING');
  await f.runner.pump();
  assert.deepEqual(executed, ['First outcome'], 'the next child waits for independent verification');
});

test('SPLIT ignores accompanying task edits instead of rewriting the retired task or shifted siblings', async t => {
  const f = setup(t, [child('First'), child('Second')]);
  const later = f.queue.list()[1];
  f.reply.taskEdits = [{ seq: f.original.seq, description: 'Unwanted original rewrite' },
    { seq: later.seq, description: 'Unwanted later rewrite' }];
  await f.runner.supervise(f.original);
  assert.equal(f.queue.get(f.original.id), undefined);
  assert.equal(f.queue.get(later.id).description, later.description);
  assert.ok(f.queue.list().every(row => !row.description.includes('Unwanted')));
});

test('a child retry changes approach feedback without re-authoring its persisted local contract', async t => {
  const f = setup(t, [child('First'), child('Second')]);
  await f.runner.supervise(f.original);
  const claimed = f.queue.claimNext();
  f.queue.update(claimed.id, { status: 'VERIFYING', validationReport: 'A local implementation defect remains.' });
  f.reply.verdict = 'RETRY';
  f.reply.feedback = 'Correct the one observed event-handler defect.';
  f.reply.taskEdits = [{ seq: claimed.seq, description: 'Rebuild the entire original objective',
    implVerifyPrompt: 'Inspect everything again', solutionVerifyPrompt: 'Test every sibling again',
    solutionVerifyCommand: 'different command' }];
  await f.runner.supervise(f.queue.get(claimed.id));
  const retried = f.queue.get(claimed.id);
  assert.equal(retried.status, 'PENDING');
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']) {
    assert.equal(retried[field], claimed[field]);
  }
  assert.equal(retried.supervisorFeedback, f.reply.feedback);
  assert.equal(f.queue.countEvents(claimed.id, 'scope-edit-rejected'), 1);
});

test('a failed replacement insert rolls back deletion, children, ordering and accumulated spend', async t => {
  const f = setup(t, [child('First'), child('Reject child')]);
  const before = f.queue.list();
  const connection = new DatabaseSync(f.queue.path);
  connection.exec(`CREATE TRIGGER reject_replacement BEFORE INSERT ON tasks
    WHEN NEW.title = 'Reject child' BEGIN SELECT RAISE(ABORT, 'test replacement failure'); END;`);
  connection.close();
  await f.runner.supervise(f.original);
  const after = f.queue.list();
  assert.deepEqual(after.map(row => [row.id, row.seq, row.title]), before.map(row => [row.id, row.seq, row.title]));
  for (const field of ['description', 'output', 'validationReport', 'errorLog', 'attempts']) {
    assert.equal(f.queue.get(f.original.id)[field], f.original[field]);
  }
  assert.equal(f.queue.stats().usage.input, 1, 'the attempted supervisor turn still cost tokens');
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.get(f.original.id).activityPhase, 'decomposition_required');
  assert.match(f.load('src/queue/recoveryDecomposition.ts').readDecomposition(f.queue, f.original).reason, /test replacement failure/);
  assert.equal(f.calls.length, 0);
});

test('incomplete supplied plans are rejected whole without deleting the task or inventing completion', async t => {
  for (const parts of [[child('Only one')], [child('First'), { title: 'Missing checks', description: 'Incomplete' }]]) {
    const f = setup(t, parts);
    await f.runner.supervise(f.original);
    assert.equal(f.queue.list().length, 2);
    assert.equal(f.queue.get(f.original.id).status, 'VERIFYING');
    assert.equal(f.queue.get(f.original.id).validationReport, f.original.validationReport);
    assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.get(f.original.id).activityPhase, 'decomposition_required');
    assert.equal(f.calls.length, 0);
  }
});

test('an omitted replacement plan retains the bounded-planner fallback', async t => {
  const f = setup(t, undefined);
  let replans = 0;
  f.runner.replanOrPause = async (task, reason) => {
    replans++;
    assert.equal(task.id, f.original.id);
    assert.equal(reason, f.reply.feedback);
  };
  await f.runner.supervise(f.original);
  assert.equal(replans, 1);
  assert.ok(f.queue.get(f.original.id));
});

test('retirement survives database reopening and cannot be overwritten by a stale verdict', async t => {
  const f = setup(t, [child('First'), child('Second')]);
  await f.runner.supervise(f.original);
  await f.runner.supervise(f.original);
  const { TaskQueue } = f.load('src/queue/db.ts');
  const reopened = TaskQueue.open(f.queue.path);
  try {
    assert.equal(reopened.get(f.original.id), undefined);
    assert.deepEqual(reopened.list().map(row => row.title), ['First', 'Second', 'Later work']);
    assert.equal(reopened.claimNext().title, 'First');
    assert.equal(reopened.finishExecution(f.original.id, f.original.attempts,
      { status: 'VERIFYING', output: 'Late original worker result' }), false);
    assert.ok(reopened.list().every(row => row.output !== 'Late original worker result'));
  } finally { reopened.close(); }
});

test('a later active worker is cancelled and fenced when replacement children precede it', async t => {
  const f = setup(t, [child('First'), child('Second')]);
  const later = f.queue.claimNext();
  let stopped = 0;
  f.runner.executionAbort = () => { stopped++; };
  const generation = f.runner.executionGen;
  await f.runner.supervise(f.original);
  assert.equal(stopped, 1);
  assert.ok(f.runner.executionGen > generation);
  assert.equal(f.queue.get(later.id).status, 'PENDING');
  assert.equal(f.queue.finishExecution(later.id, later.attempts,
    { status: 'VERIFYING', output: 'Stale later worker result' }), false);
  assert.equal(f.queue.claimNext().title, 'First');
});

test('a pending older supervisor response cannot rewrite the committed replacements', async t => {
  let finishOlder, calls = 0;
  const parts = [child('First'), child('Second')];
  const f = setup(t, parts, { superviseTask: async () => {
    if (++calls === 1) return new Promise(resolve => { finishOlder = resolve; });
    return decision(parts);
  } });
  const older = f.runner.supervise(f.original);
  await f.runner.supervise(f.original);
  finishOlder({ verdict: 'RETRY', feedback: 'Obsolete verdict', usage,
    taskEdits: [{ seq: f.original.seq, description: 'Must never reach a replacement' }] });
  await older;
  assert.equal(f.queue.get(f.original.id), undefined);
  assert.deepEqual(f.queue.list().map(row => row.title), ['First', 'Second', 'Later work']);
  assert.ok(f.queue.list().every(row => !row.description.includes('Must never reach')));
  assert.equal(f.queue.stats().usage.input, 1, 'the abandoned response cannot mutate replacement rows');
});

test('required acceptance command cannot disappear from the replacement plan', async t => {
  const f = setup(t, [child('First'), child('Second')]);
  f.queue.update(f.original.id, { solutionVerifyCommand: 'npm test' });
  await f.runner.supervise(f.queue.get(f.original.id));
  assert.equal(f.queue.runState, 'RUNNING');
  assert.equal(f.queue.get(f.original.id).activityPhase, 'decomposition_required');
  assert.equal(f.queue.get(f.original.id).solutionVerifyCommand, 'npm test');
  assert.match(f.load('src/queue/recoveryDecomposition.ts').readDecomposition(f.queue, f.original).reason, /retain the original required verification command/);
});
