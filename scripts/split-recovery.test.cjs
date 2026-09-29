// Real queue, orchestrator and SQLite; only the replacement planner is stubbed. A task that
// fails is replaced by smaller tasks and the original is deleted, and that split must land
// even when the planner gives no usable answer. Only an outage of the provider itself is
// retried instead of split, because it says nothing about the task.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test('a failed task is always replaced by smaller tasks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-split-recovery-'));
  const host = await createHost({ workspace: root, log() {} });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const split = host.load('src/queue/splitPlan.ts');
  const decomposition = host.load('src/queue/failureDecomposition.ts');
  const realDecide = decomposition.decideFailureDecomposition;
  let number = 0;
  const failed = (description = 'Add the header. Then wire the menu item. Finally show the dialog on click.') => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `split-${++number}.db`));
    queue.setRunState('RUNNING');
    const runner = new Orchestrator(host.context, host.output, queue);
    runner.pump = async () => {};
    queue.insert({ title: 'Add the dialog', description, solutionVerifyPrompt: 'Click the menu item; the dialog shows.',
      status: 'VERIFYING' }, 1);
    const task = queue.list()[0];
    queue.update(task.id, { attempts: 1, startedAt: Date.now(), output: 'partial work' });
    runner.requestFailureDecomposition(queue.get(task.id), 'The executor stopped without finishing.');
    return { queue, runner, task };
  };
  const planner = fake => { decomposition.decideFailureDecomposition = fake; };

  try {
    await t.test('the host split divides a task by its own sentences and keeps the acceptance check last', () => {
      const parts = split.mechanicalSplit({ title: 'Add the dialog',
        description: 'Add the header. Then wire the menu item. Finally show the dialog on click.',
        solutionVerifyPrompt: 'Click the menu item; the dialog shows.' }, 'the executor stopped');
      assert.ok(parts.length >= 2);
      assert.equal(parts.at(-1).solutionVerifyPrompt, 'Click the menu item; the dialog shows.');
      assert.ok(parts.every(part => part.title && part.description && part.solutionVerifyPrompt));
      const single = split.mechanicalSplit({ title: 'Fix it', description: 'Fix the flaky login test',
        solutionVerifyPrompt: 'npm test' }, 'timeout in login.spec.ts');
      assert.equal(single.length, 2);
      assert.match(single[0].description, /timeout in login\.spec\.ts/);
      assert.equal(single[1].solutionVerifyPrompt, 'npm test');
    });

    await t.test('a proposed split is repaired rather than refused', () => {
      const parent = { title: 'Big task', description: 'Do everything.', solutionVerifyPrompt: 'Run all checks.' };
      const parts = split.normalizeSplitParts([
        { title: 'Copy', description: 'Do everything.' },
        { title: 'Incomplete' },
        { title: 'Rename helper', description: 'Rename the helper in five files.', targets: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] },
        { title: 'Update docs', description: 'Update the user guide.' },
      ], parent);
      assert.deepEqual(parts.map(part => part.title), ['Rename helper (files 1 of 2)', 'Rename helper (files 2 of 2)', 'Update docs']);
      assert.match(parts.at(-1).solutionVerifyPrompt, /Run all checks\./, 'the original acceptance rides on the last task');
      assert.throws(() => split.normalizeSplitParts([{ title: 'Only', description: 'One task.' }], parent), /at least two/);
      // The planner reply parser is the same lenient path.
      const task = { description: 'Do everything.', solutionVerifyPrompt: 'Run all checks.', title: 'Big task' };
      const decision = decomposition.parseFailureDecomposition(JSON.stringify({ splitInto: [
        { title: 'First', description: 'Do the first half.' }, { title: 'Second', description: 'Do the second half.' }] }), task);
      assert.equal(decision.splitInto.length, 2);
      assert.throws(() => decomposition.parseFailureDecomposition('no json at all', task));
    });

    await t.test('an unusable planner reply still ends with smaller tasks and the original deleted', async () => {
      const { queue, runner, task } = failed();
      planner(async () => { throw Object.assign(Error('No usable failure decomposition after one repair: not json'),
        { invalidDecomposition: true, invalidPlan: 'prose', usage: USAGE }); });
      try {
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the failed task is deleted');
        const rows = queue.list();
        assert.ok(rows.length >= 2, `${rows.length} smaller tasks replaced it`);
        assert.ok(rows.every(row => row.status === 'PENDING'));
        assert.equal(queue.events(task.id, -1).filter(e => e.kind === 'mechanical-split').length, 1);
        assert.equal(queue.runState, 'RUNNING');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('an unclassified planner error is a split too, not a retry on a timer', async () => {
      const { queue, runner, task } = failed();
      planner(async () => { throw Error('The replacement planner returned something odd.'); });
      try {
        await runner.tick();
        assert.equal(queue.get(task.id), undefined);
        assert.ok(queue.list().length >= 2);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a provider outage is retried, never split, and does not spend the allowance', async () => {
      const { queue, runner, task } = failed();
      planner(async () => { throw Error('dial tcp 10.30.30.10:443: connectex: A connection attempt failed'); });
      try {
        await runner.tick();
        const row = queue.get(task.id);
        assert.ok(row, 'the task is kept while the provider is unreachable');
        assert.equal(queue.events(task.id, -1).filter(e => e.kind === 'mechanical-split').length, 0);
        assert.equal(queue.list().length, 1);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a usable planner plan is committed as proposed', async () => {
      const { queue, runner, task } = failed();
      planner(async (_c, _o, row) => ({ verdict: 'SPLIT', feedback: 'divided', usage: USAGE,
        splitInto: split.normalizeSplitParts([
          { title: 'Add the header', description: 'Add only the header.', solutionVerifyPrompt: 'Header visible.' },
          { title: 'Wire the menu', description: 'Wire the menu item and dialog.', solutionVerifyPrompt: 'Dialog shows.' }], row),
        decomposition: { remainingOutcomes: [], coverage: [], assignments: [] } }));
      try {
        await runner.tick();
        assert.equal(queue.get(task.id), undefined);
        assert.deepEqual(queue.list().map(row => row.title), ['Add the header', 'Wire the menu']);
        assert.equal(queue.events(task.id, -1).filter(e => e.kind === 'mechanical-split').length, 0);
      } finally { runner.dispose(); queue.close(); }
    });
  } finally {
    decomposition.decideFailureDecomposition = realDecide;
    await host.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
