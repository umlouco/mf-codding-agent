const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('legacy test ownership stops resume the original executor task, not a repair loop', async t => {
  const scratch = path.resolve(__dirname, '../.mfagent/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'ownership-recovery-'));
  const host = await createHost({ workspace: root, log() {} });
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const queue = host.queue;
  const runner = new Orchestrator(host.context, host.output, queue);
  runner.pump = async () => {};
  const repairs = [];
  runner.repairTests = async (task, reason) => { repairs.push(reason); };
  const stop = 'queue ownership: the supervisor must rewrite existing test internal/config/config_test.go.';
  const halted = 'queue ownership: supervisor test repair cannot rewrite application file parnassus.config.json';
  const create = patch => {
    queue.insert({ title: 'Vision configuration', description: 'Update config, tests and JSON.',
      solutionVerifyPrompt: 'Run config tests and build.', status: 'VERIFYING' }, queue.list().length + 1);
    const task = queue.list().at(-1);
    queue.update(task.id, { attempts: 1, output: stop,
      errorLog: `[attempt 1] the core stopped the turn (supervisor_repair_required): ${stop}\n[attempt 1] supervisor test repair halted: ${halted}`,
      supervisorFeedback: `[SUPERVISOR_TEST_REPAIR] ${stop}`, ...patch });
    return queue.get(task.id);
  };
  try {
    await t.test('reported two-role deadlock returns to executor and preserves evidence', async () => {
      queue.setRunState('RUNNING');
      const task = create({});
      await runner.tick();
      const current = queue.get(task.id);
      assert.equal(current.status, 'PENDING');
      assert.equal(current.output, task.output);
      assert.equal(current.errorLog, task.errorLog);
      assert.equal(current.description, task.description);
      assert.equal(current.solutionVerifyPrompt, task.solutionVerifyPrompt);
      assert.equal(current.attempts, task.attempts);
      assert.equal(repairs.length, 0);
      assert.match(current.supervisorFeedback, /executor.*tests/i);
      await runner.tick();
      assert.equal(queue.get(task.id).status, 'PENDING');
      assert.equal(repairs.length, 0, 'old history must not trigger another repair');
    });
    await t.test('a still-old core retains remediation feedback for the next executor attempt', async () => {
      const task = queue.list()[0];
      queue.update(task.id, { attempts: task.attempts + 1, status: 'VERIFYING',
        supervisorFeedback: `[SUPERVISOR_TEST_REPAIR] ${stop}`,
        errorLog: `[attempt ${task.attempts + 1}] the core stopped the turn (supervisor_repair_required): ${stop}` });
      await runner.tick();
      assert.equal(queue.get(task.id).status, 'PENDING');
      assert.match(queue.get(task.id).activityDetail, /installed.*core|core.*installed/i);
      assert.equal(repairs.length, 0);
    });
    await t.test('stale ownership output without a repair marker is not marked complete', async () => {
      queue.setRunState('RUNNING');
      const task = create({ supervisorFeedback: '' });
      await runner.tick();
      assert.equal(queue.get(task.id).status, 'PENDING');
    });
    await t.test('explicit non-ownership repair requests retain their scoped repair lane', async () => {
      for (const previous of queue.list()) queue.update(previous.id, { status: 'VERIFIED' });
      const task = create({ output: 'Actual assertion failure.', errorLog: '',
        supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] Owner requested fixture correction.' });
      await runner.tick();
      assert.equal(repairs.length, 1);
      assert.equal(queue.get(task.id).status, 'VERIFYING');
    });
    await t.test('paused tasks stay paused while exhausted work remains pending', async () => {
      const paused = create({ status: 'PAUSED' });
      const exhausted = create({ attempts: 1, maxAttempts: 1 });
      await runner.tick();
      assert.equal(queue.get(paused.id).status, 'PAUSED');
      assert.equal(queue.get(exhausted.id).status, 'PENDING');
      assert.equal(queue.get(exhausted.id).attempts, 1);
    });
    await t.test('an application-file repair rejection is split, not returned to the executor', async () => {
      for (const previous of queue.list()) queue.update(previous.id, { status: 'VERIFIED' });
      queue.setRunState('RUNNING');
      const guard = 'queue ownership: supervisor test repair cannot rewrite application file parnassus.config.json; '
        + 'return a SPLIT_TASK decision so the implementation change and its verification are separate tasks';
      queue.insert({ title: 'Vision configuration', description: 'Update config and tests.',
        solutionVerifyPrompt: 'Run config tests and build.', status: 'VERIFYING' }, queue.list().length + 1);
      const task = queue.list().at(-1);
      queue.update(task.id, { attempts: 1, status: 'VERIFYING',
        supervisorFeedback: `[SUPERVISOR_TEST_REPAIR] ${guard}`,
        errorLog: `[attempt 1] supervisor test repair halted: ${guard}` });
      queue.log(task.id, 'supervisor', 'test-repair-halted', guard);
      const splits = [];
      runner.repairTests = Orchestrator.prototype.repairTests;
      runner.requestFailureDecomposition = (row, reason) => { splits.push({ id: row.id, reason }); };
      await runner.tick();
      assert.equal(splits.length, 1, 'application-file repair rejection must enter failure decomposition');
      assert.match(splits[0].reason, /cannot rewrite application file/);
      const current = queue.get(task.id);
      assert.equal(current.status, 'VERIFYING', 'the executor must not resume the obsolete ownership stop');
      assert.equal(current.supervisorFeedback, `[SUPERVISOR_TEST_REPAIR] ${guard}`);
    });
  } finally {
    runner.dispose();
    await host.close();
    assert(root.startsWith(scratch + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
