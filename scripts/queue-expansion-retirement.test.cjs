const { test } = require('node:test');
const { assert, fixture, usage } = require('./queue-scope-helpers.cjs');

test('phase expansion retires its row without journalling against the deleted parent ID', async t => {
  const executed = [];
  const f = fixture(t, {
    expandPhase: async () => ({ tasks: [
      { title: 'First expanded task', description: 'Implement the first focused outcome.' },
      { title: 'Second expanded task', description: 'Implement the second focused outcome.' },
    ], splitRequests: [], usage, cutOff: false }),
    executeTask: async (_, __, task) => {
      executed.push(task.title);
      return { text: 'The focused outcome is implemented.', notes: '', usage,
        completion: { status: 'READY_FOR_VALIDATION' } };
    },
  });
  f.queue.replaceAll([{ title: 'Original phase', description: 'Plan independent outcomes.', kind: 'phase',
    region: JSON.stringify({ paths: ['src'], fileCount: 2 }) },
  { title: 'Later task', description: 'Retain its position after the expanded work.' }]);
  f.queue.setRunState('RUNNING');
  const original = f.queue.list()[0];
  await assert.doesNotReject(f.runner.pump(), 'a successful committed expansion must not fail with a foreign-key error');
  assert.equal(f.queue.get(original.id), undefined);
  const rows = f.queue.list();
  assert.deepEqual(rows.map(row => row.title), ['First expanded task', 'Second expanded task', 'Later task']);
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3]);
  assert.ok(rows.every(row => row.status === 'PENDING'));
  assert.equal(f.queue.stats().usage.input, 1);
  const events = f.queue.events(null, -1).filter(event => event.kind === 'expanded');
  assert.equal(events.length, 1, 'the transaction already writes the durable expansion receipt');
  assert.equal(events[0].taskId, null);
  assert.match(events[0].message, /Original phase.*2 row/);
  await f.runner.pump();
  assert.deepEqual(executed, ['First expanded task']);
  assert.equal(f.queue.get(rows[0].id).status, 'VERIFYING');
});
