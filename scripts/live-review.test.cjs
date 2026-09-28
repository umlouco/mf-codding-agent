// Real queue, orchestrator and SQLite; only the supervisor and tester models are
// stubbed. Pins the two guards against a task that works for hours without
// finishing: a live stop is held while the coder is making changes, and the
// supervisor may rewrite one task only `queue.maxRewrites` times before the run
// pauses for the owner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test('live stops and supervisor rewrites are bounded', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-live-review-'));
  const host = await createHost({ workspace: root, log() {}, settings: { 'queue.reviewEveryModelCalls': 1 } });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const { formatToolEvent } = host.load('src/queue/orchestratorState.ts');
  const { workerProgress } = host.load('src/queue/workerProgress.ts');
  const monitor = host.load('src/queue/monitor.ts');
  const tester = host.load('src/queue/tester.ts');
  const decision = host.load('src/queue/supervisorDecision.ts');
  const decomposition = host.load('src/queue/failureDecomposition.ts');
  const { serializeValidation } = host.load('src/queue/validation.ts');
  const realReview = monitor.reviewProgress;
  const realRunTester = tester.runTester;
  const realDecide = decision.decideAfterTest;
  const realDecideDecomposition = decomposition.decideFailureDecomposition;

  let number = 0;
  const fresh = () => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `live-${++number}.db`));
    queue.setRunState('RUNNING');
    return queue;
  };
  const runnerFor = queue => {
    const runner = new Orchestrator(host.context, host.output, queue);
    runner.pump = async () => {};
    return runner;
  };
  const executing = queue => {
    queue.insert({ title: 'Rename the plugin', description: 'Rename the plugin to Example System.',
      solutionVerifyPrompt: 'The plugins page lists Example System.' }, 1);
    return queue.claimNext();
  };
  let round = 0;
  const tool = (queue, id, name, input, status = 'ok') => {
    queue.log(id, 'executor', 'activity:model_wait', `round ${++round} of 80`);
    queue.log(id, 'executor', 'tool', formatToolEvent(name, input, status, `output ${round}`, 5));
  };
  const supervisorSays = action => {
    const calls = [];
    monitor.reviewProgress = async (_c, _o, task) => {
      calls.push(task.id);
      return { action, reason: 'The coder is not converging.', guidance: 'Finish the header edit first.',
        rewrittenDescription: `Rewritten ${calls.length}: edit the header, then run the spec.`,
        solutionVerifyPrompt: `Rewritten check ${calls.length}.`, usage: USAGE };
    };
    return calls;
  };
  const priorRewrites = (queue, id, n) => {
    for (let i = 0; i < n; i++) queue.log(id, 'supervisor', 'task-edited', `earlier rewrite ${i + 1}`);
  };
  // A task rewrite now mandates replacement: the planner authors the smaller
  // tasks and the host deletes the original.
  const stubDecomposition = () => {
    decomposition.decideFailureDecomposition = async () => ({
      verdict: 'SPLIT', feedback: 'Split the rewritten task into smaller steps.', usage: USAGE,
      splitInto: [
        { title: 'Edit the header', description: 'Edit the header first.', solutionVerifyPrompt: 'The header shows the new name.' },
        { title: 'Run the spec', description: 'Run the spec after the header edit.', solutionVerifyPrompt: 'The spec passes.' },
      ],
      decomposition: { remainingOutcomes: [], coverage: [], assignments: [] },
    });
  };

  try {
    await t.test('workerProgress counts changes and test runs, not reading', () => {
      const event = (id, name, input, status = 'ok', actor = 'executor') =>
        ({ id, taskId: 1, actor, kind: 'tool', message: formatToolEvent(name, input, status, 'x', 3), at: 0 });
      const cases = [
        [event(1, 'edit_file', { path: 'a.php' }), true],
        [event(2, 'edit_file', { path: 'a.php' }, 'error'), false],
        [event(3, 'read_file', { path: 'a.php' }), false],
        [event(4, 'run_shell', { command: 'cd /p && grep -rn "Old Name" . 2>/dev/null | sort' }), false],
        [event(5, 'run_shell', { command: "cd /p && sed -i 's/Old/New/' spec.js && grep -n New spec.js" }), true],
        [event(6, 'run_shell', { command: 'echo done > /tmp/marker' }), true],
        [event(7, 'playwright_test', { spec: 'specs/row.spec.js' }), true],
        [event(8, 'edit_file', { path: 'a.php' }, 'ok', 'supervisor'), false],
        [{ id: 9, taskId: 1, actor: 'executor', kind: 'tool', message: 'edit_file() → start', at: 0 }, false],
      ];
      for (const [e, moved] of cases) {
        assert.equal(workerProgress([e]).length, moved ? 1 : 0, e.message.split('\n')[0]);
      }
    });

    await t.test('a live rewrite is held while the coder is making changes, at most twice per attempt', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const calls = supervisorSays('STOP_AND_REWRITE_TASK');
      stubDecomposition();
      try {
        const task = executing(queue);
        for (const file of ['a.php', 'b.php']) {
          tool(queue, task.id, 'edit_file', { path: file });
          await runner.reviewWork(queue.get(task.id));
          const row = queue.get(task.id);
          assert.equal(row.status, 'EXECUTING', 'the working coder is not stopped');
          assert.equal(row.description, task.description);
          assert.match(row.supervisorFeedback, /held off because you are making changes.*Finish the header edit first/);
        }
        assert.equal(queue.countEvents(task.id, 'stop-deferred'), 2);

        tool(queue, task.id, 'edit_file', { path: 'c.php' });
        await runner.reviewWork(queue.get(task.id));
        assert.equal(calls.length, 3);
        // The third rewrite is applied as a replacement, never an in-place edit.
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the rewritten task is deleted');
        const rows = queue.list();
        assert.ok(rows.length >= 2, `the rewrite produced ${rows.length} smaller tasks`);
        assert.ok(rows.every(r => r.status === 'PENDING'));
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a live rewrite of a coder that only reads is applied at once as a replacement', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      supervisorSays('STOP_AND_REWRITE_TASK');
      stubDecomposition();
      try {
        const task = executing(queue);
        tool(queue, task.id, 'read_file', { path: 'a.php' });
        tool(queue, task.id, 'run_shell', { command: 'grep -rn "Old Name" .' });
        await runner.reviewWork(queue.get(task.id));
        assert.equal(queue.countEvents(task.id, 'stop-deferred'), 0);
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the rewritten task is deleted');
        const rows = queue.list();
        assert.ok(rows.length >= 2, `the rewrite produced ${rows.length} smaller tasks`);
        assert.ok(rows.every(r => r.status === 'PENDING'));
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a live rewrite past the limit pauses the run and keeps the task text', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      supervisorSays('STOP_AND_REWRITE_TASK');
      try {
        const task = executing(queue);
        priorRewrites(queue, task.id, 2);
        tool(queue, task.id, 'read_file', { path: 'a.php' });
        await runner.reviewWork(queue.get(task.id));
        const row = queue.get(task.id);
        assert.equal(queue.runState, 'PAUSED');
        assert.equal(row.status, 'PAUSED');
        assert.equal(row.description, task.description, 'the held rewrite is not applied');
        assert.equal(row.activityPhase, 'owner_review');
        assert.match(queue.events(task.id, 20).find(e => e.kind === 'rewrite-limit').message, /Rewritten 1/);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a post-test REWRITE past the limit pauses; Start grants a fresh allowance', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const fail = { conclusion: 'FAIL', summary: 'Row still reads the old name.', implementationEvidence: '',
        behaviorEvidence: '', checks: [{ kind: 'browser', name: 'row', passed: false, evidence: 'old name' }],
        remaining: 'Rename not applied.' };
      tester.runTester = async () => ({ report: fail, serialized: serializeValidation(fail), text: '', usage: USAGE,
        executed: ['playwright_test'] });
      let verdicts = 0;
      decision.decideAfterTest = async () => ({ usage: USAGE, action: 'REWRITE', reason: 'rephrase',
        guidance: 'edit first', rewrittenDescription: `Rewritten after test ${++verdicts}.` });
      try {
        queue.insert({ title: 'Rename the plugin', description: 'Rename the plugin to Example System.',
          solutionVerifyPrompt: 'The plugins page lists Example System.', status: 'VERIFYING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, { attempts: 3, startedAt: Date.now() });
        priorRewrites(queue, task.id, 2);

        await runner.tick();
        let row = queue.get(task.id);
        assert.equal(queue.runState, 'PAUSED');
        assert.equal(row.description, task.description);
        assert.equal(row.attempts, 3, 'a held rewrite does not restart the attempt budget');

        stubDecomposition();
        queue.resumePaused();
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the resumed rewrite is a replacement, not an edit');
        const rows = queue.list();
        assert.ok(rows.length >= 2, `the rewrite produced ${rows.length} smaller tasks`);
        assert.ok(rows.every(r => r.status === 'PENDING'));
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('maxRewrites 0 switches the limit off', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const cfg = runner.cfg.bind(runner);
      runner.cfg = (key, fallback) => key === 'queue.maxRewrites' ? 0 : cfg(key, fallback);
      supervisorSays('STOP_AND_REWRITE_TASK');
      stubDecomposition();
      try {
        const task = executing(queue);
        priorRewrites(queue, task.id, 5);
        tool(queue, task.id, 'read_file', { path: 'a.php' });
        await runner.reviewWork(queue.get(task.id));
        assert.equal(queue.runState, 'RUNNING');
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the rewrite is applied as a replacement');
        assert.ok(queue.list().length >= 2);
      } finally { runner.dispose(); queue.close(); }
    });
  } finally {
    monitor.reviewProgress = realReview;
    tester.runTester = realRunTester;
    decision.decideAfterTest = realDecide;
    decomposition.decideFailureDecomposition = realDecideDecomposition;
    await host.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
