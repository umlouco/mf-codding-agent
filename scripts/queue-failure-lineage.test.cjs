const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loader } = require('./queue-scope-helpers.cjs');
const { TaskQueue } = loader()('src/queue/db.ts');
const { decompositionFamily } = loader()('src/queue/dbFailureLineage.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const task = title => ({ title, description: `Implement only ${title}`, solutionVerifyPrompt: `Observe ${title}` });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-failure-lineage-'));
  const file = path.join(directory, 'queue.db');
  const handles = [];
  const open = () => { const queue = TaskQueue.open(file); handles.push(queue); return queue; };
  t.after(() => {
    for (const handle of handles) handle.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('mf-failure-lineage-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const queue = open();
  queue.addAll([{ ...task('failed parent'), status: 'FAILED' }]);
  return { queue, open, parent: queue.list()[0] };
}

test('every descendant inherits failure lineage without overwriting independent scope metadata', t => {
  const { queue, parent } = fixture(t);
  const family = decompositionFamily(parent);
  queue.splitTask(parent.id, [
    { ...task('first step'), region: JSON.stringify({ scopeSplit: { key: 'first', targets: ['one.ts'] } }) },
    { ...task('second step'), region: JSON.stringify({ failureFamily: 'attempted new family', scopeSplit: { key: 'second' } }) },
  ]);
  const [first, second] = queue.list();
  assert.deepEqual(plain(JSON.parse(first.region)), { failureFamily: family, scopeSplit: { key: 'first', targets: ['one.ts'] } });
  assert.equal(JSON.parse(second.region).failureFamily, family);
  assert.equal(first.activityPhase, '', 'ordinary children are not yet mandatory decomposition');
  queue.splitTask(first.id, [
    { ...task('narrower first'), region: JSON.stringify({ scopeSplit: { key: 'narrow', archiveKey: 'retained-archive' } }) },
    task('narrower acceptance'),
  ], true);
  assert.ok(queue.list().every(row => JSON.parse(row.region).failureFamily === family));
  const descendant = queue.list()[0];
  assert.equal(JSON.parse(descendant.region).scopeSplit.archiveKey, 'retained-archive');
  assert.match(descendant.splitScope, /QUEUE-ASSIGNED SPLIT STEP/);
  assert.equal(JSON.parse(queue.getMeta(`failureDecompositionFamily:v1:${family}`)).splits, 2);
});

test('normal child splits cannot bypass the family recursion allowance across a reopen', t => {
  const { queue, parent, open } = fixture(t);
  const family = decompositionFamily(parent);
  let current = parent;
  for (let index = 0; index < 32; index++) {
    assert.equal(queue.splitTask(current.id, [task(`scope ${index}`), task(`handoff ${index}`)]), 2);
    current = queue.list()[0];
  }
  const reopened = open();
  const before = plain(reopened.list());
  assert.throws(() => reopened.splitTask(current.id, [task('escape scope'), task('escape handoff')]),
    error => error.invalidDecomposition === true && /verified family outcome/.test(error.message));
  assert.deepEqual(plain(queue.list()), before);
  assert.ok(queue.list().every(row => decompositionFamily(row) === family));
  assert.equal(JSON.parse(queue.getMeta(`failureDecompositionFamily:v1:${family}`)).splits, 32);
});

test('family admission rolls back with replacement failure instead of consuming or forgetting its reservation', t => {
  const { queue, parent, open } = fixture(t);
  const family = decompositionFamily(parent);
  const key = `failureDecompositionFamily:v1:${family}`;
  const before = plain(queue.list());
  queue.db.exec(`CREATE TRIGGER reject_second_lineage_child BEFORE INSERT ON tasks
    WHEN NEW.title='reject second' BEGIN SELECT RAISE(ABORT, 'injected child insert failure'); END;`);
  assert.throws(() => queue.splitTask(parent.id, [task('first inserted'), task('reject second')]), /injected/);
  assert.deepEqual(plain(open().list()), before);
  assert.equal(queue.getMeta(key), '');
  assert.equal(queue.events(null, -1).filter(event => event.kind === 'split-archive').length, 0);
  queue.db.exec('DROP TRIGGER reject_second_lineage_child');
  assert.equal(queue.splitTask(parent.id, [task('first inserted'), task('now accepted')]), 2);
  assert.equal(JSON.parse(queue.getMeta(key)).splits, 1);
});
