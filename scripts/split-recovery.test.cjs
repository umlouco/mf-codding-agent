// Real queue, orchestrator and SQLite; model turns and the executor are stubbed
// at their source modules. Every way a task fails must end with smaller tasks
// in its place and the original deleted, and the split must land even when the
// planner gives no usable answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const outcome = (status, completion = {}) => ({
  text: JSON.stringify({ report: 'r', completion: { status } }), ok: true, cutOff: false, stopReason: 'end_turn',
  usage, notes: '', completion: { status, summary: '', filesChanged: [], developmentChecks: [], ...completion },
});

test('a failed task is replaced by smaller tasks and the original is deleted', async t => {
  const scratch = path.resolve(__dirname, '../.mfagent/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'split-recovery-'));
  const host = await createHost({ workspace: root, log() {} });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const { formatToolEvent } = host.load('src/queue/orchestratorState.ts');
  const { decompositionFamily } = host.load('src/queue/dbFailureLineage.ts');
  const { decompositionDigest } = host.load('src/queue/recoveryDecomposition.ts');
  const split = host.load('src/queue/splitPlan.ts');
  const watch = host.load('src/queue/executionWatch.ts');
  const { parseCompletionClaim } = host.load('src/queue/validation.ts');
  // Stubbed at their source modules. agents.ts re-exports both live, which the
  // assertions below prove before any tick could reach a real model or core.
  const runtime = host.load('src/queue/agentRuntime.ts');
  const execution = host.load('src/queue/agentExecution.ts');
  const agents = host.load('src/queue/agents.ts');
  const realRunOnce = runtime.runOnce;
  const realExecuteTask = execution.executeTask;
  const turns = fake => { runtime.runOnce = fake; assert.equal(agents.runOnce, fake); };
  const executor = fake => { execution.executeTask = fake; assert.equal(agents.executeTask, fake); };
  const unreachablePlanner = () => {
    let calls = 0;
    turns(async () => { calls++; throw new Error('the planner is unreachable'); });
    return () => calls;
  };
  const runs = [];
  let number = 0;
  const fresh = () => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `split-${++number}.db`));
    queue.setRunState('RUNNING');
    const runner = new Orchestrator(host.context, host.output, queue);
    runs.push({ queue, runner });
    return { queue, runner };
  };
  // Hand-offs schedule ticks and pumps of their own; let them all run out.
  const settle = async runner => {
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      await runner.drain();
    }
  };
  const executing = (queue, title, description, startedAt = Date.now()) => {
    queue.insert({ title, description, solutionVerifyPrompt: 'go test ./...' }, queue.list().length + 1);
    const task = queue.list().at(-1);
    queue.update(task.id, { status: 'EXECUTING', attempts: 1, startedAt });
    queue.recordActivity(task.id, 'tool', 'working');
    queue.log(task.id, 'executor', 'claimed', 'attempt 1');
    return task;
  };
  const failed = (queue, title, description) => {
    queue.insert({ title, description, solutionVerifyPrompt: 'npm test' }, queue.list().length + 1);
    const task = queue.list().at(-1);
    queue.update(task.id, { status: 'VERIFYING', activityPhase: 'decomposition_required', activityDetail: 'The executor stopped working.' });
    return task;
  };

  try {
    await t.test('the host split divides a task by its own sentences and keeps the acceptance check last', () => {
      const description = 'Extend internal/config/config.go only: add `VisionConfig` with json tags baseUrl, model, ' +
        'timeoutSec; set `Default()` values. Add cases to internal/config/config_test.go: a zero Config normalizes to ' +
        "Default().Vision. Then update the repository's parnassus.config.json so it carries the same `vision` block. " +
        'This block is the single source of truth the probe and console preflight read.';
      const parts = split.mechanicalSplit({ title: 'Add Vision settings', description,
        solutionVerifyPrompt: 'Run go test ./internal/config/...' }, 'the executor stopped');
      assert.equal(parts.length, 3);
      assert.match(parts[0].title, /^Step 1\/3: Extend internal\/config\/config\.go/);
      assert.match(parts[1].description, /THIS STEP:\nAdd cases to internal\/config\/config_test\.go/);
      assert.match(parts[2].description, /THIS STEP:\nThen update the repository's parnassus\.config\.json/);
      assert.equal(parts[2].solutionVerifyPrompt, 'Run go test ./internal/config/...');
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
        { title: 'Update docs', description: 'Update the API reference.', solutionVerifyPrompt: 'Read the API reference.' },
      ], parent);
      assert.deepEqual(parts.map(part => part.title),
        ['Rename helper (files 1 of 2)', 'Rename helper (files 2 of 2)', 'Update docs', 'Update docs (2)']);
      assert.match(parts[0].description, /a\.ts, b\.ts, c\.ts/);
      assert.match(parts[1].description, /d\.ts, e\.ts/);
      assert.match(parts[3].solutionVerifyPrompt, /^Read the API reference\.[\s\S]*Run all checks\./);
      assert.throws(() => split.normalizeSplitParts([{ title: 'Only', description: 'One task.' }], parent), /at least two/);
    });

    await t.test('the same tool call with the same result, repeated, reads as a loop', () => {
      const call = (id, command, output) => ({ id, taskId: 1, actor: 'executor', kind: 'tool', at: id,
        message: formatToolEvent('run_shell', { command }, 'ok', output, 10) });
      const looping = [5, 4, 3, 2].map(id => call(id, 'go test ./...', 'FAIL config_test.go:12'));
      assert.match(watch.detectToolLoop(looping), /same tool call with the same result 4 times/);
      const working = [5, 4, 3, 2].map(id => call(id, `go test ./pkg${id}`, `ok pkg${id}`));
      assert.equal(watch.detectToolLoop(working), undefined);
    });

    await t.test('the executor can propose its own split in its completion report', () => {
      const claim = parseCompletionClaim(JSON.stringify({ report: 'r', completion: { status: 'NEEDS_MORE_WORK', summary: 'too big',
        splitInto: [{ title: 'A', description: 'First half.' }, { title: 'B', description: 'Second half.', targets: ['x.ts'] }] } }));
      assert.deepEqual(claim.splitInto.map(part => part.title), ['A', 'B']);
      assert.equal(parseCompletionClaim(JSON.stringify({ completion: { status: 'NEEDS_MORE_WORK', splitInto: [] } })).splitInto, undefined);
    });

    await t.test('an executor that stops before finishing fails the task; its replacements then run', async () => {
      const { queue, runner } = fresh();
      queue.insert({ title: 'Parent', description: 'Add the config block. Then write the tests for it and run them.',
        solutionVerifyPrompt: 'go test ./...' }, 1);
      const parent = queue.list()[0];
      const ran = [];
      executor(async (_context, _output, task) => {
        ran.push(task.title);
        return task.title === 'Parent' ? outcome('NEEDS_MORE_WORK', { summary: 'Only half done.' }) : outcome('READY_FOR_VALIDATION');
      });
      let plans = 0;
      turns(async () => {
        plans++;
        return { stopReason: 'end_turn', usage, text: JSON.stringify({ feedback: 'Two halves.', splitInto: [
          { title: 'Add the config block', description: 'Add the block to config.go.', solutionVerifyPrompt: 'go build ./...' },
          { title: 'Test the config block', description: 'Write and run the config tests.', solutionVerifyPrompt: 'go test ./internal/config/...' },
        ] }) };
      });
      await runner.pump();
      await settle(runner);
      assert.equal(queue.get(parent.id), undefined, 'the failed task is deleted');
      assert.equal(plans, 1);
      assert.deepEqual(ran, ['Parent', 'Add the config block', 'Test the config block']);
      assert.ok(queue.list().every(row => row.status === 'VERIFIED'));
      assert.match(queue.list()[1].solutionVerifyPrompt, /go test \.\/\.\.\./, 'the last replacement keeps the original check');
    });

    await t.test("an executor's own proposed split is committed without a planner turn", async () => {
      const { queue, runner } = fresh();
      queue.insert({ title: 'Parent', description: 'Build the whole feature.', solutionVerifyPrompt: 'npm test' }, 1);
      const parent = queue.list()[0];
      executor(async () => outcome('NEEDS_MORE_WORK', { splitInto: [
        { title: 'Build the API', description: 'Add the endpoint.', solutionVerifyPrompt: 'npm run test:api', targets: ['src/api.ts'] },
        { title: 'Build the UI', description: 'Add the screen.', solutionVerifyPrompt: 'npm run test:ui', targets: ['src/ui.tsx'] },
      ] }));
      const planned = unreachablePlanner();
      await runner.pump();
      runner.pump = async () => {};
      await settle(runner);
      assert.equal(planned(), 0, 'no planner turn is needed');
      assert.equal(queue.get(parent.id), undefined);
      assert.deepEqual(queue.list().map(row => [row.title, row.status]), [['Build the API', 'PENDING'], ['Build the UI', 'PENDING']]);
      assert.match(queue.list()[1].solutionVerifyPrompt, /npm test/);
    });

    await t.test('a planner with no usable answer, or no answer in time, still ends in a split', async () => {
      const planners = [
        async () => ({ text: 'I think this task is fine as it is.', stopReason: 'end_turn', usage }),
        (_context, _output, _role, _prompt, opts) => new Promise((_, reject) => opts.onAbort?.(() => reject(new Error('cancelled')))),
      ];
      for (const planner of planners) {
        const { queue, runner } = fresh();
        runner.pump = async () => {};
        runner.splitPlannerTimeoutMs = 20;
        const parent = failed(queue, 'Parent', 'Write the parser. Then wire it into the loader and test it.');
        turns(planner);
        await runner.tick();
        await settle(runner);
        assert.equal(queue.get(parent.id), undefined);
        assert.deepEqual(queue.list().map(row => row.title),
          ['Step 1/2: Write the parser.', 'Step 2/2: Then wire it into the loader and test it.']);
        assert.equal(queue.list()[1].solutionVerifyPrompt, 'npm test');
      }
    });

    await t.test('a worker that goes silent has stopped working: its task is split', async () => {
      const { queue, runner } = fresh();
      runner.pump = async () => {};
      const planned = unreachablePlanner();
      queue.insert({ title: 'Parent', description: 'Start the server and check every route.', solutionVerifyPrompt: 'curl checks' }, 1);
      const parent = queue.list()[0];
      const old = Date.now() - 60 * 60_000;
      queue.update(parent.id, { status: 'EXECUTING', attempts: 1 });
      queue.db.prepare('UPDATE tasks SET started_at = ?, last_activity_at = ? WHERE id = ?').run(old, old, parent.id);
      await runner.tick();
      await settle(runner);
      assert.equal(planned(), 1);
      assert.equal(queue.get(parent.id), undefined);
      assert.equal(queue.list().length, 2);
      assert.ok(queue.list().every(row => row.status === 'PENDING'));
    });

    await t.test('a loop in the journal stops the executor and splits its task, without a model review', async () => {
      const { queue, runner } = fresh();
      runner.pump = async () => {};
      const planned = unreachablePlanner();
      const parent = executing(queue, 'Parent', 'Fix the failing config test and make the build pass.');
      for (let i = 0; i < 4; i++) {
        queue.log(parent.id, 'executor', 'tool', formatToolEvent('run_shell', { command: 'go test ./...' }, 'ok', 'FAIL config_test.go:12', 900));
      }
      let aborted = false;
      runner.executionAbort = () => { aborted = true; };
      await runner.tick();
      await settle(runner);
      assert.equal(aborted, true, 'the looping executor is stopped');
      assert.equal(planned(), 1, 'only the split planner is asked; the loop itself needed no model');
      assert.equal(queue.countEvents(parent.id, 'journal-review:LOOP'), 1);
      assert.equal(queue.get(parent.id), undefined);
      assert.equal(queue.list().length, 2);
    });

    await t.test('the supervisor reading a rabbit hole in the journal stops the executor and splits the task', async () => {
      const { queue, runner } = fresh();
      runner.pump = async () => {};
      Object.defineProperty(runner, 'reviewIntervalMs', { value: 0 });
      const parent = executing(queue, 'Parent', 'Add the vision field to config.go and its test.', Date.now() - 60_000);
      for (const file of ['logging.go', 'metrics.go', 'dashboard.vue']) {
        queue.log(parent.id, 'executor', 'tool', formatToolEvent('edit_file', { path: file }, 'ok', `rewrote ${file}`, 5));
      }
      queue.log(parent.id, 'executor', 'reasoning', 'While I am here I will redesign the metrics dashboard.');
      const prompts = [];
      turns(async (_context, _output, _role, prompt) => {
        prompts.push(prompt);
        if (/live journal/.test(prompt)) {
          return { stopReason: 'end_turn', usage,
            text: '{"verdict":"RABBIT_HOLE","reason":"It is redesigning the metrics dashboard instead of the config field."}' };
        }
        throw new Error('the planner is unreachable');
      });
      let aborted = false;
      runner.executionAbort = () => { aborted = true; };
      await runner.tick();
      await settle(runner);
      assert.equal(aborted, true);
      assert.equal(queue.countEvents(parent.id, 'journal-review:RABBIT_HOLE'), 1);
      assert.match(prompts[0], /redesign the metrics dashboard/, 'the supervisor reads what the executor was thinking');
      assert.equal(queue.get(parent.id), undefined);
      assert.ok(queue.list().length >= 2);
    });

    await t.test('a journal that shows progress leaves the executor working', async () => {
      const { queue, runner } = fresh();
      runner.pump = async () => {};
      Object.defineProperty(runner, 'reviewIntervalMs', { value: 0 });
      const parent = executing(queue, 'Parent', 'Add the vision field to config.go and its test.', Date.now() - 60_000);
      queue.log(parent.id, 'executor', 'tool', formatToolEvent('edit_file', { path: 'config.go' }, 'ok', 'added Vision', 5));
      turns(async () => ({ stopReason: 'end_turn', usage, text: '{"verdict":"PROGRESS","reason":"It is adding the field."}' }));
      await runner.tick();
      await settle(runner);
      assert.equal(queue.get(parent.id).status, 'EXECUTING');
      assert.equal(queue.countEvents(parent.id, 'journal-review:PROGRESS'), 1);
    });

    await t.test('an executor stopped by a provider outage is retried, not split', async () => {
      const { queue, runner } = fresh();
      queue.insert({ title: 'Parent', description: 'Do the work.', solutionVerifyPrompt: 'npm test' }, 1);
      const parent = queue.list()[0];
      executor(async () => {
        throw new Error('cannot reach https://srv-staillm02.connexall.com/v1: dial tcp 10.30.30.10:443: connectex: timeout');
      });
      const planned = unreachablePlanner();
      await runner.pump();
      runner.pump = async () => {};
      await settle(runner);
      const row = queue.get(parent.id);
      assert.equal(row.status, 'PENDING');
      assert.doesNotMatch(row.activityPhase, /^decomposition_/);
      assert.equal(planned(), 0);
    });

    await t.test('the legacy drain leaves a task waiting for its split alone', () => {
      const { queue } = fresh();
      queue.insert({ title: 'Parent', description: 'Work.', status: 'VERIFYING' }, 1);
      const row = queue.list()[0];
      queue.update(row.id, { activityPhase: 'decomposition_required' });
      assert.equal(queue.drainVerification(), 0);
      assert.equal(queue.get(row.id).status, 'VERIFYING');
    });

    await t.test('a family split repeatedly without a verified result is rebuilt from its original task', async () => {
      const { queue, runner } = fresh();
      runner.pump = async () => {};
      runner.wakeAfterHandoff = () => {};
      const planned = unreachablePlanner();
      const original = failed(queue, 'Original', 'Build the importer and document how to run it.');
      await runner.tick();
      const [first, second] = queue.list();
      assert.ok(first && second && queue.get(original.id) === undefined);
      // Spend the family's allowance, then fail the first replacement.
      queue.setMeta(`failureDecompositionFamily:v1:${decompositionFamily(queue.get(first.id))}`,
        JSON.stringify({ proofs: [], splits: 32 }));
      queue.update(first.id, { status: 'VERIFYING', activityPhase: 'decomposition_required', activityDetail: 'failed again' });
      const calls = planned();
      await runner.tick();
      assert.equal(planned(), calls, 'no planner turn is spent on a split the family cannot make');
      const rebuilt = queue.get(first.id);
      assert.equal(rebuilt.title, 'Original');
      assert.equal(rebuilt.status, 'VERIFYING');
      assert.equal(queue.get(second.id), undefined, 'the abandoned sibling is pruned');
      await runner.tick();
      assert.equal(planned(), calls + 1, 'the rebuilt task is split afresh in a new family');
      assert.equal(queue.get(first.id), undefined);
      assert.equal(queue.list().length, 2);
    });

    await t.test('after two rebuilds the executor works on the original task directly', async () => {
      const { queue, runner } = fresh();
      runner.pump = async () => {};
      runner.wakeAfterHandoff = () => {};
      const planned = unreachablePlanner();
      const row = failed(queue, 'Stubborn', 'Do the hard thing.');
      queue.setMeta(`failureDecompositionFamily:v1:${decompositionFamily(queue.get(row.id))}`,
        JSON.stringify({ proofs: [], splits: 32 }));
      queue.setMeta(`decompositionRebuilds:v1:${decompositionDigest(['Stubborn', 'Do the hard thing.', 'npm test'])}`, '2');
      await runner.tick();
      const current = queue.get(row.id);
      assert.equal(current.status, 'PENDING');
      assert.equal(current.activityPhase, 'executor_recovery');
      assert.equal(planned(), 0);
    });
  } finally {
    runtime.runOnce = realRunOnce;
    execution.executeTask = realExecuteTask;
    for (const { queue, runner } of runs) {
      runner.dispose();
      await runner.drain();
      queue.close();
    }
    await host.close();
    assert(root.startsWith(scratch + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
