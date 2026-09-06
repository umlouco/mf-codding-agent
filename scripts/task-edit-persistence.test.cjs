// Run with: node --test scripts/task-edit-persistence.test.cjs
// Exercise the actual queue and SQLite transactions, including independent
// connections, a full reopen, and failures after earlier writes have occurred.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const sqlite = require('node:sqlite');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'queue', 'db.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const exported = {};
vm.runInNewContext(outputText, {
  exports: exported, process, __dirname,
  require: name => {
    if (name === 'fs') return fs;
    if (name === 'path') return path;
    if (name === 'node:sqlite') return sqlite;
    throw new Error(`Test deliberately excludes optional module ${name}`);
  },
});
const { TaskQueue, taskEditSummary } = exported;

function fixture(t, tasks) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-task-edit-test-'));
  const file = path.join(directory, 'queue.sqlite');
  const handles = [];
  const open = () => {
    const queue = TaskQueue.open(file);
    handles.push(queue);
    return queue;
  };
  t.after(() => {
    for (const handle of handles) handle.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mf-task-edit-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const queue = open();
  queue.replaceAll(tasks);
  return { queue, open, file };
}

function task(title, extra = {}) {
  return { title, description: `Implement ${title}`, ...extra };
}

function plan(extra = {}) {
  return { edits: [], deletes: [], adds: [], ...extra };
}

function audit(queue, kind) {
  return queue.db.prepare('SELECT task_id,message FROM task_events WHERE kind=? ORDER BY id').all(kind);
}

test('251 removals, replacements and edits commit and survive an independent read and full reopen', t => {
  const tasks = Array.from({ length: 300 }, (_, index) =>
    task(index < 294 && index % 6 === 0 ? `Keep ${index}` : `SCORM ${index}`));
  const { queue, open, file } = fixture(t, tasks);
  const snapshot = queue.list();
  const removed = snapshot.filter(row => row.title.startsWith('SCORM'));
  const retained = snapshot.filter(row => row.title.startsWith('Keep'));
  assert.equal(removed.length, 251);
  const receipt = queue.applyTaskEdits(snapshot, plan({
    edits: [{ seq: retained[0].seq, title: 'Updated engineering task' }],
    deletes: removed.map(row => row.seq),
    adds: [task('Replacement A'), task('Replacement B')],
  }));
  assert.deepEqual({ ...receipt }, { edited: 1, deleted: 251, added: 2, remaining: 51 });
  assert.equal(taskEditSummary(receipt), 'Saved queue changes: removed 251, updated 1, added 2. 51 tasks remain.');
  const independent = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(independent.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 51);
    assert.equal(independent.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'SCORM%'").get().n, 0);
  } finally { independent.close(); }
  queue.close();
  const reopened = open();
  const rows = reopened.list();
  assert.equal(rows.length, 51);
  assert.deepEqual(rows.slice(0, 49).map(row => row.id), retained.map(row => row.id));
  assert.equal(rows[0].title, 'Updated engineering task');
  assert.deepEqual(rows.slice(-2).map(row => row.title), ['Replacement A', 'Replacement B']);
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 51 }, (_, i) => i + 1));
  const deletedAudit = audit(reopened, 'task-deleted');
  assert.equal(deletedAudit.length, 251);
  assert.ok(deletedAudit.every(row => row.task_id === null), 'deletion receipts survive foreign-key cascades');
  assert.deepEqual(deletedAudit.map(row => JSON.parse(row.message).id), removed.map(row => row.id));
  assert.equal(audit(reopened, 'task-edited').length, 1);
  assert.equal(audit(reopened, 'task-added').length, 2);
  assert.equal(audit(reopened, 'tasks-edited-by-prompt')[0].message, taskEditSummary(receipt));
});

test('a later SQL failure rolls back prior edits, deletes, ordering and audit together', t => {
  const { queue, open } = fixture(t, [task('Edit me'), task('Delete first'), task('Delete second'), task('Keep')]);
  const before = queue.list();
  queue.db.exec(`CREATE TRIGGER fail_second_delete BEFORE DELETE ON tasks
    WHEN OLD.id=${before[2].id} BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END`);
  assert.throws(() => queue.applyTaskEdits(before, plan({
    edits: [{ seq: 1, title: 'Must roll back' }], deletes: [2, 3], adds: [task('Must not appear')],
  })), /injected deletion failure/);
  assert.deepEqual(queue.list(), before);
  assert.equal(audit(queue, 'task-edited').length, 0);
  assert.equal(audit(queue, 'task-deleted').length, 0);
  assert.equal(audit(queue, 'tasks-edited-by-prompt').length, 0);
  queue.close();
  assert.deepEqual(open().list(), before);
});

test('failed replacement insertion restores removed originals', t => {
  const { queue, open } = fixture(t, [task('Original'), task('Keep')]);
  const before = queue.list();
  queue.db.exec(`CREATE TRIGGER fail_add BEFORE INSERT ON tasks
    BEGIN SELECT RAISE(ABORT,'injected insertion failure'); END`);
  assert.throws(() => queue.applyTaskEdits(before, plan({ deletes: [1], adds: [task('Replacement')] })),
    /injected insertion failure/);
  queue.close();
  const reopened = open();
  assert.deepEqual(reopened.list(), before);
  assert.equal(audit(reopened, 'task-deleted').length, 0);
});

test('concurrent reordering preserves snapshot task identities and current survivor order', t => {
  const { queue, open } = fixture(t, [task('Delete A'), task('Keep B'), task('Update C')]);
  const snapshot = queue.list();
  const other = open();
  other.reorder([snapshot[2].id, snapshot[0].id, snapshot[1].id]);
  const receipt = queue.applyTaskEdits(snapshot, plan({ deletes: [1], edits: [{ seq: 3, title: 'Updated C' }] }));
  assert.deepEqual({ ...receipt }, { edited: 1, deleted: 1, added: 0, remaining: 2 });
  const survivors = other.list();
  assert.deepEqual(survivors.map(row => row.id), [snapshot[2].id, snapshot[1].id]);
  assert.deepEqual(survivors.map(row => row.seq), [1, 2]);
  assert.equal(survivors[0].title, 'Updated C');
});

test('changed or replaced targets reject the entire proposal before unrelated changes', t => {
  const cases = [
    ['content', (queue, target) => queue.update(target.id, { description: 'Changed while planning' })],
    ['attempt', (queue, target) => queue.update(target.id, { attempts: target.attempts + 1 })],
    ['status', (queue, target) => queue.update(target.id, { status: 'FAILED' })],
    ['replacement', (queue, target) => queue.splitTask(target.id, [task('New identity A'), task('New identity B')])],
  ];
  for (const [name, mutate] of cases) {
    const { queue, open } = fixture(t, [task('Keep original'), task(`Target ${name}`)]);
    const snapshot = queue.list();
    mutate(open(), snapshot[1]);
    const before = queue.list();
    assert.throws(() => queue.applyTaskEdits(snapshot, plan({
      edits: [{ seq: 1, title: 'Must not change' }], deletes: [2], adds: [task('Must not appear')],
    })), /changed or was replaced/, name);
    assert.deepEqual(queue.list(), before, name);
    assert.equal(audit(queue, 'tasks-edited-by-prompt').length, 0, name);
  }
});

test('verified and active targets fail explicitly without partial deletion', t => {
  for (const status of ['VERIFIED', 'EXECUTING', 'VERIFYING']) {
    const { queue } = fixture(t, [task('Eligible'), task('Protected', { status })]);
    const before = queue.list();
    assert.throws(() => queue.applyTaskEdits(before, plan({ deletes: [1, 2] })), new RegExp(status));
    assert.deepEqual(queue.list(), before);
    assert.equal(audit(queue, 'task-deleted').length, 0);
  }
});

test('heartbeat, token and output logging do not invalidate an otherwise unchanged target', t => {
  const { queue, open } = fixture(t, [task('Delete after inspection'), task('Keep')]);
  const snapshot = queue.list();
  const other = open();
  other.db.prepare(`UPDATE tasks SET updated_at=updated_at+1, last_activity_at=123,
    activity_phase='tool', activity_detail='still inspecting', tokens_in=99, output='progress log'
    WHERE id=?`).run(snapshot[0].id);
  const receipt = queue.applyTaskEdits(snapshot, plan({ deletes: [1] }));
  assert.equal(receipt.deleted, 1);
  assert.equal(other.get(snapshot[0].id), undefined);
});

test('deduplicated deletion and no-op edits have factual counts', t => {
  const { queue } = fixture(t, [task('Delete'), task('Unchanged')]);
  const snapshot = queue.list();
  const receipt = queue.applyTaskEdits(snapshot, plan({
    deletes: [1, 1, 1], edits: [{ seq: 2, title: snapshot[1].title }],
  }));
  assert.deepEqual({ ...receipt }, { edited: 0, deleted: 1, added: 0, remaining: 1 });
  assert.equal(audit(queue, 'task-deleted').length, 1);
  assert.equal(audit(queue, 'task-edited').length, 0);
  const remaining = queue.list();
  const unchanged = queue.applyTaskEdits(remaining, plan({ edits: [{ seq: 1, description: remaining[0].description }] }));
  assert.deepEqual({ ...unchanged }, { edited: 0, deleted: 0, added: 0, remaining: 1 });
  assert.equal(taskEditSummary(unchanged), 'No tasks changed. 1 tasks remain.');
  assert.equal(audit(queue, 'tasks-edited-by-prompt').at(-1).message, taskEditSummary(unchanged));
});

test('unknown, ambiguous and conflicting selectors cannot silently skip or target another row', t => {
  const { queue } = fixture(t, [task('First'), task('Second')]);
  const snapshot = queue.list();
  const proposals = [
    plan({ deletes: [999] }),
    plan({ deletes: [1.5] }),
    plan({ deletes: [1], edits: [{ seq: 1, title: 'Conflicting' }] }),
    plan({ edits: [{ seq: 1, title: 'A' }, { seq: 1, title: 'B' }] }),
  ];
  for (const proposal of proposals) {
    assert.throws(() => queue.applyTaskEdits(snapshot, proposal));
    assert.deepEqual(queue.list(), snapshot);
  }
  assert.throws(() => queue.applyTaskEdits([snapshot[0], { ...snapshot[1], seq: 1 }], plan({ deletes: [1] })), /ambiguous/);
  assert.equal(audit(queue, 'tasks-edited-by-prompt').length, 0);
});
