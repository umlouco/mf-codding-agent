const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { loader } = require('./queue-scope-helpers.cjs');
const { TaskQueue, TASK_STATUSES } = loader()('src/queue/db.ts');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-failure-storage-'));
  const file = path.join(directory, 'queue.db');
  const handles = [];
  const open = () => { const q = TaskQueue.open(file); handles.push(q); return q; };
  t.after(() => {
    for (const handle of handles) handle.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mf-failure-storage-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { queue: open(), open, file };
}
const task = title => ({ title, description: `Implement ${title}`, solutionVerifyPrompt: `Prove ${title}` });
const plain = value => JSON.parse(JSON.stringify(value));

test('legacy FAILED rows migrate once to required decomposition without losing their evidence', t => {
  const { queue, file, open } = fixture(t);
  queue.addAll([task('original')]);
  const id = queue.list()[0].id;
  queue.setMeta('goal', 'Preserve the exact original planner request');
  queue.close();
  const legacy = new DatabaseSync(file);
  legacy.exec('DROP TRIGGER tasks_decomposition_insert; DROP TRIGGER tasks_decomposition_update;');
  legacy.prepare(`UPDATE tasks SET status='FAILED', output='worker output', validation_report='rejected check',
    error_log='supervisor test repair cannot rewrite application file', attempts=7,
    tokens_in=91, finished_at=12 WHERE id=?`).run(id);
  legacy.close();
  const migrated = open();
  const saved = migrated.get(id);
  assert.equal(saved.status, 'VERIFYING');
  assert.equal(saved.activityPhase, 'decomposition_required');
  assert.equal(saved.finishedAt, null);
  assert.equal(saved.output, 'worker output');
  assert.equal(saved.validationReport, 'rejected check');
  assert.match(saved.errorLog, /cannot rewrite application file/);
  assert.equal(saved.attempts, 7);
  assert.equal(saved.tokensIn, 91);
  assert.equal(migrated.getMeta('goal'), 'Preserve the exact original planner request');
  assert.equal(migrated.isComplete(), false);
  assert.equal(migrated.claimNext(), undefined);
  assert.equal(migrated.countEvents(id, 'decomposition-required'), 1);
  assert.equal(open().countEvents(id, 'decomposition-required'), 1);
});

test('FAILED imports and late writes never become terminal or repeat execution', t => {
  const { queue, open } = fixture(t);
  queue.addAll([{ ...task('failed import'), status: 'FAILED' }, task('independent')]);
  const failed = queue.list()[0];
  assert.equal(failed.status, 'VERIFYING');
  assert.equal(failed.activityPhase, 'decomposition_required');
  assert.equal(queue.isComplete(), false);
  assert.equal(queue.claimNext().title, 'independent');
  const writer = open();
  for (const status of ['PENDING', 'EXECUTING', 'VERIFYING', 'VERIFIED', 'FAILED', 'PAUSED']) {
    writer.update(failed.id, { status, activityPhase: 'claimed', finishedAt: Date.now() });
    assert.equal(queue.get(failed.id).status, 'VERIFYING');
    assert.equal(queue.get(failed.id).activityPhase, 'decomposition_required');
    assert.equal(queue.get(failed.id).finishedAt, null);
  }
  assert.equal(TASK_STATUSES.includes('FAILED'), false);
});

test('reset and activity updates cannot erase failed-parent evidence or a decomposition job', t => {
  const { queue } = fixture(t);
  queue.addAll([task('failed execution')]);
  const claimed = queue.claimNext();
  queue.update(claimed.id, { status: 'FAILED', output: 'report', validationReport: 'invalid check',
    errorLog: 'ownership rejection', activityDetail: 'supervisor cannot rewrite application file',
    supervisorFeedback: 'original repair guidance', region: '{"failureFamily":"original"}',
    finishedAt: Date.now() });
  queue.addUsage(claimed.id, { input: 70 });
  queue.setMeta('failureDecomposition:v1:job', 'durable recovery request');
  queue.appendLog(claimed.id, 'supervisor', 'tool-error', 'original failure', 100);
  assert.equal(queue.finishExecution(claimed.id, claimed.attempts, { status: 'VERIFIED' }), false);
  queue.update(claimed.id, { activityPhase: 'decomposition_planning' });
  queue.recordActivity(claimed.id, 'heartbeat', 'stale worker is alive');
  assert.equal(queue.get(claimed.id).activityPhase, 'decomposition_planning');
  const beforeReset = plain(queue.get(claimed.id));
  assert.equal(queue.resetFrom(1, 'retry everything'), 0);
  queue.resetAll();
  const saved = queue.get(claimed.id);
  assert.deepEqual(plain(saved), beforeReset);
  assert.equal(saved.status, 'VERIFYING');
  assert.equal(saved.activityPhase, 'decomposition_planning');
  assert.equal(saved.output, 'report');
  assert.equal(saved.validationReport, 'invalid check');
  assert.equal(saved.errorLog, 'ownership rejection');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.startedAt, claimed.startedAt);
  assert.equal(saved.activityDetail, 'supervisor cannot rewrite application file');
  assert.equal(saved.supervisorFeedback, 'original repair guidance');
  assert.equal(saved.tokensIn, 70);
  assert.equal(queue.logsTail(saved.id).length, 1);
  assert.equal(queue.getMeta('failureDecomposition:v1:job'), 'durable recovery request');
  assert.equal(queue.claimNext(), undefined);
});

test('older direct SQL reset cannot manufacture a fresh attempt identity or erase failure guidance', t => {
  const { queue, file, open } = fixture(t);
  queue.addAll([task('failed execution')]);
  const claimed = queue.claimNext();
  queue.update(claimed.id, { status: 'FAILED', errorLog: 'ownership rejection',
    activityDetail: 'exact tool rejection', supervisorFeedback: 'preserve original repair guidance' });
  const before = plain(queue.get(claimed.id));
  const legacy = new DatabaseSync(file);
  legacy.prepare(`UPDATE tasks SET status='PENDING', attempts=0, started_at=NULL,
    activity_phase='', activity_detail='', supervisor_feedback='', last_activity_at=NULL,
    updated_at=0 WHERE id=?`).run(claimed.id);
  legacy.close();
  assert.deepEqual(plain(open().get(claimed.id)), before);
});

test('atomic replacement requires at least two children and archives the entire failed contract and journal', t => {
  const { queue, open } = fixture(t);
  queue.addAll([task('original'), task('next')]);
  const parent = queue.claimNext();
  const longReport = 'evidence '.repeat(1500) + 'END OF ORIGINAL EVIDENCE';
  queue.update(parent.id, { status: 'FAILED', validationReport: longReport, errorLog: 'ownership rejection' });
  queue.log(parent.id, 'supervisor', 'failure-detail', 'Retain this journal event after replacement');
  assert.equal(queue.splitTask(parent.id, [task('only one')]), 0);
  assert.throws(() => queue.splitTask(parent.id, [task('first'), { title: 'invalid' }]), /Every split part/);
  assert.ok(open().get(parent.id));
  assert.equal(queue.splitTask(parent.id, [task('first'), task('second')]), 2);
  const observed = open();
  assert.equal(observed.get(parent.id), undefined);
  assert.deepEqual(plain(observed.list().map(row => [row.title, row.status])),
    [['first', 'PENDING'], ['second', 'PENDING'], ['next', 'PENDING']]);
  const archive = observed.events(null, -1).find(event => event.kind === 'split-archive');
  const decoded = JSON.parse(archive.message);
  assert.equal(decoded.task.validationReport, longReport);
  assert.equal(decoded.task.errorLog, 'ownership rejection');
  assert.ok(decoded.events.some(event => event.kind === 'failure-detail'));
  assert.equal(queue.claimNext().title, 'first');
});
