// Real queue, orchestrator and SQLite; only the supervisor and tester models are
// stubbed. Pins the two guards against a task that works for hours without
// finishing: a live stop is held while the coder is making changes, and the
// supervisor may rewrite one task only `queue.maxRewrites` times before the
// task is replaced by smaller ones. The run never pauses for an owner.
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

    await t.test('guidance survives evidence that moved on during the review; a stop does not', async () => {
      for (const [action, delivered] of [['CONTINUE_EXECUTION', true], ['STOP_AND_REWRITE_TASK', false]]) {
        const queue = fresh();
        const runner = runnerFor(queue);
        try {
          const task = executing(queue);
          tool(queue, task.id, 'read_file', { path: 'a.php' });
          // The coder finishes a tool call while the supervisor is still deciding.
          monitor.reviewProgress = async () => {
            tool(queue, task.id, 'edit_file', { path: 'b.php' });
            return { action, reason: 'Judged on the earlier journal.', guidance: 'Do not rebuild; the build already passed.',
              rewrittenDescription: 'Something else entirely.', usage: USAGE };
          };
          await runner.reviewWork(queue.get(task.id));
          const row = queue.get(task.id);
          assert.equal(row.status, 'EXECUTING', 'the worker keeps running either way');
          assert.equal(queue.countEvents(task.id, 'review-outdated'), delivered ? 0 : 1);
          assert.equal(row.supervisorFeedback.includes('Do not rebuild'), delivered);
        } finally { runner.dispose(); queue.close(); }
      }
    });

    await t.test('a review that overlapped many model calls delays the next one in proportion', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      try {
        const task = executing(queue);
        // reviewEveryModelCalls is 1 in this file. The first review sees one call and is due.
        tool(queue, task.id, 'read_file', { path: 'a.php' });
        assert.equal(runner.shouldReview(queue.get(task.id), 0), true);
        const cursor = queue.events(task.id, 1, true)[0].id;
        // While that review ran the coder made four more calls, so the next is due after twelve.
        runner.reviewed.set(task.id, { attempt: task.attempts, at: 0, eventId: cursor, minCalls: 12 });
        for (let i = 0; i < 4; i++) tool(queue, task.id, 'read_file', { path: `c${i}.php` });
        assert.equal(runner.shouldReview(queue.get(task.id), 0), false, 'four calls are far below twelve');
        for (let i = 0; i < 8; i++) tool(queue, task.id, 'read_file', { path: `d${i}.php` });
        assert.equal(runner.shouldReview(queue.get(task.id), 0), true);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a live rewrite past the limit replaces the task and never pauses the run', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      supervisorSays('STOP_AND_REWRITE_TASK');
      stubDecomposition();
      try {
        const task = executing(queue);
        priorRewrites(queue, task.id, 2);
        tool(queue, task.id, 'read_file', { path: 'a.php' });
        await runner.reviewWork(queue.get(task.id));
        const row = queue.get(task.id);
        assert.equal(queue.runState, 'RUNNING', 'no owner is asked to press Start');
        assert.equal(row.description, task.description, 'the rewrite itself is not applied');
        assert.notEqual(row.activityPhase, 'owner_review');
        assert.match(queue.events(task.id, 20).find(e => e.kind === 'rewrite-limit').message, /Rewritten 1/);
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the task is replaced by smaller ones');
        assert.ok(queue.list().length >= 2);
        assert.equal(queue.runState, 'RUNNING');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a post-test REWRITE past the limit replaces the task without pausing', async () => {
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

        stubDecomposition();
        await runner.tick();
        assert.equal(queue.runState, 'RUNNING', 'the rewrite limit never parks the run for an owner');
        assert.equal(queue.get(task.id)?.description ?? task.description, task.description, 'the rewrite is never an in-place edit');
        assert.equal(queue.events(task.id, 20).filter(e => e.kind === 'rewrite-limit').length, 1);
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the task is replaced, not edited');
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
