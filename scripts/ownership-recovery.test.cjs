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
  // Model turns are replaced at their source. The repair lane reaches runOnce
  // through agents.ts's live re-export, so a stub that did not take would start
  // a real CLI; stubTurns proves it took before any tick runs.
  const runtime = host.load('src/queue/agentRuntime.ts');
  const agents = host.load('src/queue/agents.ts');
  const realRunOnce = runtime.runOnce;
  const stubTurns = fake => {
    runtime.runOnce = fake;
    assert.equal(agents.runOnce, fake, 'the repair lane must call the stubbed model turn');
  };
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
  const resetQueue = () => {
    for (const previous of queue.list()) queue.update(previous.id, { status: 'VERIFIED' });
    queue.setRunState('RUNNING');
  };
  // A hand-off schedules a tick of its own; let it run before asserting.
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      await runner.drain();
    }
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
    await t.test('a repair refused an application file splits the task into smaller tasks, once', async () => {
      resetQueue();
      const refusal = "PreToolUse:Edit hook error: [& 'mfcore.exe' testing-hook; exit $LASTEXITCODE]: " +
        'queue ownership: supervisor test repair cannot rewrite application file parnassus.config.json; ' +
        'stop and report the required change: the extension splits this task so that change becomes its own smaller task';
      queue.insert({ title: 'Vision configuration', description: 'Update config, tests and JSON.',
        solutionVerifyPrompt: 'Run config tests and build.', status: 'VERIFYING' }, queue.list().length + 1);
      const task = queue.list().at(-1);
      queue.update(task.id, { attempts: 1, output: 'executor handoff',
        supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] The config test asserts a stale default.' });
      let repairTurns = 0;
      let plans = 0;
      stubTurns(async (_context, _output, role, _prompt, opts) => {
        assert.equal(role, 'supervisor');
        if (opts.allowTestEdits) {
          // The Claude CLI repair turn as the host observes it: one Edit refused
          // by the hook, then the host's own abort, reported as a cancelled turn.
          repairTurns++;
          let aborted = false;
          opts.onAbort?.(() => { aborted = true; });
          opts.onEvent?.('stream/tool', { id: 'edit-1', name: 'Edit', status: 'running',
            input: { file_path: 'parnassus.config.json' } });
          opts.onEvent?.('stream/tool', { id: 'edit-1', name: 'Edit', status: 'error', output: refusal });
          assert.equal(aborted, true, 'the first ownership refusal must end the repair turn');
          throw new Error('Claude CLI turn cancelled; late output was discarded.');
        }
        plans++;
        return { stopReason: 'end_turn', usage, text: JSON.stringify({ feedback: 'The config change is its own task.',
          splitInto: [
            { title: 'Add the Vision block to the config schema', description: 'Add VisionConfig to internal/config/config.go.',
              solutionVerifyPrompt: 'go build ./...', targets: ['internal/config/config.go'] },
            { title: 'Write the vision block into parnassus.config.json', description: 'Update parnassus.config.json with the Vision defaults.',
              solutionVerifyPrompt: 'go test ./internal/config/...', targets: ['parnassus.config.json'] }] }) };
      });
      runner.repairTests = Orchestrator.prototype.repairTests;
      await runner.tick();
      await settle();
      assert.equal(repairTurns, 1);
      assert.equal(plans, 1);
      assert.equal(queue.get(task.id), undefined, 'the failed task is deleted');
      const children = queue.list().filter(row => row.status === 'PENDING');
      assert.deepEqual(children.map(row => row.title),
        ['Add the Vision block to the config schema', 'Write the vision block into parnassus.config.json']);
      assert.match(children[1].solutionVerifyPrompt, /Run config tests and build\./, 'the last replacement keeps the original acceptance');
      const requested = queue.countEvents(task.id, 'test-repair-requested');
      for (let i = 0; i < 3; i++) await runner.tick();
      await settle();
      assert.equal(queue.countEvents(task.id, 'test-repair-requested'), requested, 'a split task is never re-requested');
      assert.equal(repairTurns, 1);
      assert.equal(plans, 1);
    });
    await t.test('the reported live row, stuck behind a reverted migration, is split instead of looping', async () => {
      resetQueue();
      const legacyStop = 'queue ownership: the supervisor must rewrite existing test internal/config/config_test.go. ' +
        'Report the defect and request STOP_AND_REWRITE_TESTS';
      const oldRefusal = "PreToolUse:Edit hook error: [& 'mf-agent-0.1.53\\bin\\mfcore.exe' testing-hook; exit $LASTEXITCODE]: " +
        'queue ownership: supervisor test repair cannot rewrite application file parnassus.config.json; stop this repair ' +
        'and request SPLIT into separate implementation and verification tasks while preserving the original owner goal';
      queue.insert({ title: 'Add Vision settings to the parnassus config schema', description: 'Update config, tests and JSON.',
        solutionVerifyPrompt: 'Run config tests and build.', status: 'VERIFYING' }, queue.list().length + 1);
      const task = queue.list().at(-1);
      queue.update(task.id, { attempts: 1, output: `Execution stopped: ${legacyStop}`,
        supervisorFeedback: `[SUPERVISOR_TEST_REPAIR] ${legacyStop}`,
        errorLog: `[attempt 1] the core stopped the turn (supervisor_repair_required): ${legacyStop}. The report is partial progress.\n` +
          `[attempt 1] supervisor test repair halted: ${oldRefusal}` });
      queue.log(task.id, 'supervisor', 'test-repair-halted', oldRefusal);
      // 0.1.53 parked the halted repair for decomposition...
      queue.update(task.id, { activityPhase: 'decomposition_required', activityDetail: oldRefusal });
      // ...0.1.54's migration patch was reverted by the decomposition trigger...
      queue.update(task.id, { status: 'PENDING', finishedAt: null, activityPhase: 'requeued' });
      assert.equal(queue.get(task.id).status, 'VERIFYING', 'the trigger reverts a requeue out of decomposition');
      // ...and that build recorded the migration as done anyway.
      queue.setMeta(`executorOwnershipMigration:${task.id}`, '1');
      let plans = 0;
      stubTurns(async (_context, _output, _role, _prompt, opts) => {
        assert.equal(opts.allowTestEdits, false, 'a task waiting for its split gets no repair turn');
        plans++;
        throw new Error('cannot reach https://planner.example/v1: dial tcp: connectex: timeout');
      });
      runner.repairTests = Orchestrator.prototype.repairTests;
      await runner.tick();
      await settle();
      assert.equal(plans, 1, 'one planner attempt, then the host splits the task itself');
      assert.equal(queue.get(task.id), undefined, 'the stuck task is deleted');
      const children = queue.list().filter(row => row.status === 'PENDING');
      assert.ok(children.length >= 2);
      assert.match(children.at(-1).solutionVerifyPrompt, /Run config tests and build\./);
      assert.equal(queue.countEvents(task.id, 'test-repair-requested'), 0, 'it is never re-requested as a repair');
    });
    await t.test('a repair that already halted is never restarted; its task is split', async () => {
      resetQueue();
      queue.insert({ title: 'Fixture repair', description: 'Fix the stale fixture. Then rerun the fixture suite until it passes.',
        solutionVerifyPrompt: 'Run the fixture tests.', status: 'VERIFYING' }, queue.list().length + 1);
      const task = queue.list().at(-1);
      queue.update(task.id, { attempts: 2, supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] selectors are stale',
        errorLog: '[attempt 2] supervisor test repair halted: Supervisor test repair stopped (max_iterations).' });
      queue.log(task.id, 'supervisor', 'test-repair-halted', 'Supervisor test repair stopped (max_iterations).');
      let repairTurns = 0;
      stubTurns(async (_context, _output, _role, _prompt, opts) => {
        if (opts.allowTestEdits) repairTurns++;
        throw new Error('the planner is unavailable');
      });
      runner.repairTests = Orchestrator.prototype.repairTests;
      await runner.tick();
      await settle();
      assert.equal(repairTurns, 0, 'a halted repair must not run again');
      assert.equal(queue.get(task.id), undefined);
      const children = queue.list().filter(row => row.status === 'PENDING');
      assert.equal(children.length, 2);
      assert.ok(children.every(row => !row.supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]')));
    });
  } finally {
    runtime.runOnce = realRunOnce;
    runner.dispose();
    await host.close();
    assert(root.startsWith(scratch + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
