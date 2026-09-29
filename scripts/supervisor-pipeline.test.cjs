// Real queue, orchestrator and SQLite. The coder, tester and supervisor models
// are replaced at their module boundary, so these tests pin the supervisor
// graph itself: which lane runs next, what counts as a PASS, and how each
// post-test decision is applied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const READY = '{"completion":{"status":"READY_FOR_VALIDATION","summary":"built it","filesChanged":["index.html"]}}';

function passReport(extra = {}) {
  return {
    conclusion: 'PASS', summary: 'All acceptance checks passed.',
    implementationEvidence: 'index.html defines the canvas.', behaviorEvidence: 'Opened the page; score increments.',
    checks: [{ kind: 'browser', name: 'play', passed: true, evidence: 'score 10' }], remaining: '', ...extra,
  };
}

test('the supervisor orchestrates coder and tester', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-pipeline-'));
  const host = await createHost({ workspace: root, log() {}, settings: { 'queue.reviewEveryModelCalls': 3 } });
  const { TaskQueue } = host.load('src/queue/db.ts');
  const { Orchestrator } = host.load('src/queue/orchestrator.ts');
  const tester = host.load('src/queue/tester.ts');
  const decision = host.load('src/queue/supervisorDecision.ts');
  const decomposition = host.load('src/queue/failureDecomposition.ts');
  const { serializeValidation } = host.load('src/queue/validation.ts');
  const realRunTester = tester.runTester;
  const realDecide = decision.decideAfterTest;
  const realDecideDecomposition = decomposition.decideFailureDecomposition;
  let number = 0;
  const fresh = () => {
    const queue = TaskQueue.open(path.join(root, '.mfagent', `pipeline-${++number}.db`));
    queue.setRunState('RUNNING');
    return queue;
  };
  const runnerFor = queue => {
    const runner = new Orchestrator(host.context, host.output, queue);
    runner.pump = async () => {};
    return runner;
  };
  const verifying = (queue, fields = {}) => {
    queue.insert({ title: 'Build the page', description: 'Render a canvas game in the browser.',
      solutionVerifyPrompt: 'Open index.html in the browser and press an arrow key.', status: 'VERIFYING' }, 1);
    const task = queue.list()[0];
    queue.update(task.id, { attempts: 1, startedAt: Date.now(), output: READY, ...fields });
    return queue.get(task.id);
  };
  const stubTester = (report, executed = ['browser_open']) => {
    const calls = [];
    tester.runTester = async (_c, _o, task) => {
      calls.push(task.id);
      return { report, serialized: serializeValidation(report), text: 'tested', usage: USAGE, executed };
    };
    return calls;
  };
  const stubDecision = verdict => {
    const calls = [];
    decision.decideAfterTest = async (_c, _o, task, _s, _g, _n, facts) => {
      calls.push({ id: task.id, facts });
      return { usage: USAGE, reason: 'because', guidance: 'fix the arrow keys', ...verdict };
    };
    return calls;
  };
  // A rewrite now mandates replacement: the planner authors the smaller tasks
  // and the host deletes the original, so pin the parts it commits.
  const stubDecomposition = () => {
    decomposition.decideFailureDecomposition = async () => ({
      verdict: 'SPLIT', feedback: 'Split the rewritten task into smaller steps.', usage: USAGE,
      splitInto: [
        { title: 'Render the maze', description: 'Draw the maze itself.', solutionVerifyPrompt: 'The maze is visible.' },
        { title: 'Handle arrow keys', description: 'Move the player with the arrow keys.', solutionVerifyPrompt: 'Arrow keys move the player.' },
      ],
      decomposition: { remainingOutcomes: [], coverage: [], assignments: [] },
    });
  };

  try {
    await t.test('a coder handoff is tested, and a supported PASS verifies without a supervisor model', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const tests = stubTester(passReport());
      const decisions = stubDecision({ action: 'RETRY' });
      try {
        const task = verifying(queue);
        await runner.tick();
        assert.deepEqual(tests, [task.id]);
        assert.equal(decisions.length, 0);
        assert.equal(queue.get(task.id).status, 'VERIFIED');
        assert.equal(queue.runState, 'IDLE');
        assert.match(queue.contextInstructions, /Build the page/, 'a verified outcome reaches later tasks');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a failing tester report goes to the supervisor, and RETRY returns the task to the coder', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      stubTester({ ...passReport(), conclusion: 'FAIL', remaining: 'Arrow keys do nothing.' });
      const decisions = stubDecision({ action: 'RETRY' });
      try {
        const task = verifying(queue);
        await runner.tick();
        const row = queue.get(task.id);
        assert.equal(decisions.length, 1);
        assert.equal(row.status, 'PENDING');
        assert.equal(row.supervisorFeedback, 'fix the arrow keys');
        assert.match(row.errorLog, /supervisor RETRY/);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('REWRITE is a mandatory split: the original is replaced and deleted', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      stubTester({ ...passReport(), conclusion: 'FAIL', remaining: 'Wrong feature.' });
      stubDecision({ action: 'REWRITE', rewrittenDescription: 'Render the maze first.', solutionVerifyPrompt: 'The maze is visible.' });
      stubDecomposition();
      try {
        const task = verifying(queue);
        await runner.tick();
        assert.equal(queue.get(task.id), undefined, 'the rewritten task is deleted, not edited in place');
        const rows = queue.list();
        assert.ok(rows.length >= 2, `the rewrite produced ${rows.length} smaller tasks`);
        assert.ok(rows.every(r => r.status === 'PENDING'));
        assert.ok(rows.some(r => /Render the maze/.test(r.title)));
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('RETEST runs the tester again in the same cycle and counts against the attempt', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      let round = 0;
      tester.runTester = async () => {
        round++;
        const report = round === 1
          ? { ...passReport(), conclusion: 'INCOMPLETE', remaining: 'Server did not start.' }
          : passReport();
        return { report, serialized: serializeValidation(report), text: '', usage: USAGE, executed: ['browser_open'] };
      };
      const decisions = stubDecision({ action: 'RETEST', guidance: 'Serve with python -m http.server.' });
      try {
        const task = verifying(queue);
        await runner.tick();
        assert.equal(round, 2);
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0].facts.retests, 0);
        assert.equal(queue.get(task.id).status, 'VERIFIED');
        assert.equal(queue.events(task.id, 100).filter(e => e.kind === 'tester-retest').length, 1);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('SPLIT replaces the task with its parts and a final acceptance task', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      stubTester({ ...passReport(), conclusion: 'FAIL', remaining: 'Too much at once.' });
      stubDecision({ action: 'SPLIT', splitInto: [
        { title: 'Maze', description: 'Draw the maze.', solutionVerifyPrompt: 'Maze visible.' },
        { title: 'Movement', description: 'Move Pac-Man.', solutionVerifyPrompt: 'Arrow keys move.' },
      ] });
      try {
        verifying(queue);
        await runner.tick();
        const titles = queue.list().map(row => row.title);
        assert.deepEqual(titles, ['Maze', 'Movement', 'Final acceptance: Build the page']);
        assert(queue.list().every(row => row.status === 'PENDING'));
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a PASS this host did not produce is tested again, not trusted', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const tests = stubTester(passReport());
      try {
        const task = verifying(queue, { validationReport: serializeValidation(passReport()) });
        await runner.tick();
        assert.deepEqual(tests, [task.id]);
        assert.equal(queue.get(task.id).status, 'VERIFIED');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a tester that crashes is recorded as INCOMPLETE for the supervisor, never as PASS', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      tester.runTester = async () => { throw new Error('browser failed to launch'); };
      const decisions = stubDecision({ action: 'RETRY' });
      try {
        const task = verifying(queue);
        await runner.tick();
        assert.equal(decisions.length, 1);
        assert.notEqual(queue.get(task.id).status, 'VERIFIED');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('the supervisor reviews a running coder once it has evidence', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const reviews = [];
      runner.reviewWork = async task => { reviews.push(task.id); };
      try {
        queue.insert({ title: 'Work', description: 'Do it.', status: 'EXECUTING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, { attempts: 1, startedAt: Date.now(), lastActivityAt: Date.now() });
        await runner.tick();
        assert.equal(reviews.length, 0, 'no evidence yet, no review');
        queue.log(task.id, 'executor', 'tool', 'write_file({"path":"a"}) → ok\n[outcome:abc]');
        await runner.tick();
        assert.deepEqual(reviews, [task.id]);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('live review cadence is counted in coder model calls, not time', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      try {
        queue.insert({ title: 'Slow local model', description: 'Work.', status: 'PENDING' }, 1);
        const task = queue.claimNext();
        const round = n => queue.recordActivity(task.id, 'model_wait', `round ${n} of 80 — sending 3 messages to local`);
        // Heartbeats and tool activity are not model calls.
        queue.recordActivity(task.id, 'model_stream', 'receiving model output — 30m in');
        round(1); round(2);
        assert.equal(runner.shouldReview(queue.get(task.id), 0), false, 'two calls are below the cadence of three');
        round(3);
        assert.equal(runner.shouldReview(queue.get(task.id), 0), true);
        const reviewedAt = queue.events(task.id, 1)[0].id;
        runner.reviewed.set(task.id, { attempt: task.attempts, at: 0, eventId: reviewedAt });
        assert.equal(runner.shouldReview(queue.get(task.id), 0), false, 'a review resets the count, however long ago it was');
        round(4); round(5); round(6);
        assert.equal(runner.shouldReview(queue.get(task.id), 0), true);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a row awaiting test repair is serviced by the repair worker', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const repairs = [];
      runner.repairTests = async (row, reason) => { repairs.push(reason); };
      try {
        queue.insert({ title: 'Repair me', description: 'Work.', status: 'VERIFYING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, { output: 'executor result', supervisorFeedback: '[SUPERVISOR_TEST_REPAIR] selectors are stale' });
        await runner.tick();
        assert.equal(repairs.length, 1);
        assert.match(repairs[0], /selectors are stale/);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('an obsolete ownership stop resumes the coder, not a repair', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      const repairs = [];
      runner.repairTests = async () => { repairs.push(1); };
      const stop = 'Execution stopped: queue ownership: the supervisor must rewrite existing test ' +
        'internal/config/config_test.go. Report the defect and request STOP_AND_REWRITE_TESTS';
      try {
        queue.insert({ title: 'Config', description: 'Work.', status: 'PENDING' }, 1);
        const task = queue.list()[0];
        queue.update(task.id, { attempts: 1, output: stop,
          errorLog: '[attempt 1] the core stopped the turn (supervisor_repair_required): ' +
            'queue ownership: the supervisor must rewrite existing test internal/config/config_test.go.' });
        await runner.tick();
        assert.equal(repairs.length, 0);
        assert.equal(queue.get(task.id).status, 'PENDING');
        assert.match(queue.get(task.id).supervisorFeedback, /executor.*tests/i);
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('a worker left EXECUTING is requeued, even after its attempts are spent', async () => {
      const queue = fresh();
      try {
        queue.insert({ title: 'Lost', description: 'Work.', status: 'EXECUTING', maxAttempts: 2 }, 1);
        queue.update(queue.list()[0].id, { attempts: 2 });
        assert.equal(queue.requeueStale(0), 1);
        assert.equal(queue.list()[0].status, 'PENDING');
      } finally { queue.close(); }
    });

    await t.test('the stop detail keeps the core sentence, not just the reason code', async () => {
      const { stopDetail, TEST_OWNERSHIP_STOP } = host.load('src/queue/orchestratorState.ts');
      const stop = 'Execution stopped: queue ownership: the supervisor must rewrite existing test ' +
        'internal/config/config_test.go. Report the defect and request STOP_AND_REWRITE_TESTS';
      assert.match(stopDetail(stop), /^queue ownership:/);
      assert.equal(TEST_OWNERSHIP_STOP.test(stopDetail(stop)), true);
    });

    await t.test('tester evidence gate reads only executed checks and the task text', () => {
      const { executedChecks, evidenceProblem } = tester;
      const ui = { description: 'Draw the maze on a canvas.', solutionVerifyPrompt: 'Open the page.' };
      const cli = { description: 'Write a CLI that prints hello.', solutionVerifyPrompt: 'Run node cli.js.' };
      assert.match(evidenceProblem(cli, []), /without executing/);
      assert.equal(evidenceProblem(cli, ['run_shell']), '');
      assert.match(evidenceProblem(ui, ['run_shell']), /browser/);
      assert.equal(evidenceProblem(ui, ['browser_open']), '');
      // An MCP tool that builds, queries or drives the product is an executed check; a ticket lookup is not.
      const executedFrom = names => executedChecks(names.map(name => ({ name, ok: true, input: {} })));
      assert.equal(evidenceProblem(cli, executedFrom(['mcp__dbisam__dbisam_select'])), '');
      assert.equal(evidenceProblem(cli, executedFrom(['mcp__wsc_build__delphi_build'])), '');
      assert.match(evidenceProblem(cli, executedFrom(['mcp__jira__get_issue'])), /without executing/);
      assert.match(evidenceProblem(ui, executedFrom(['mcp__dbisam__dbisam_select'])), /user-interface/);
      assert.equal(evidenceProblem(ui, executedFrom(['mcp__delphi_gui__click_menu_item'])), '');
      assert.deepEqual(executedChecks([
        { name: 'read_file', ok: true, input: {} },
        { name: 'run_shell', ok: false, input: {} },
        { name: 'run_script', ok: true, input: { steps: [
          { tool: 'write_file', args: { content: 'x'.repeat(5000) } }, { tool: 'browser_open' }, { tool: 'browser_close' }] } },
      ]), ['browser_open']);
    });

    await t.test('a third test repair is never started: the task is replaced instead', async () => {
      const queue = fresh();
      const runner = runnerFor(queue);
      try {
        const task = verifying(queue);
        // Two repair turns already ran and finished normally (none halted), yet the tester
        // is still unsatisfied: the observed 167-verdict REPAIR_TESTS loop.
        queue.log(task.id, 'supervisor', 'test-repair-started', 'first repair');
        queue.log(task.id, 'supervisor', 'test-repair-started', 'second repair');
        await runner.repairTests(queue.get(task.id), 'The checks still cannot run.');
        assert.equal(queue.countEvents(task.id, 'test-repair-started'), 2, 'no third repair turn started');
        const row = queue.get(task.id);
        assert.equal(row.status, 'VERIFYING');
        assert.equal(row.activityPhase, 'decomposition_required', 'the split lane owns it now');
        assert.match(row.activityDetail, /already ran 2 times/);
        assert.equal(queue.runState, 'RUNNING');
      } finally { runner.dispose(); queue.close(); }
    });

    await t.test('decision guards prune actions from recorded facts', () => {
      const { allowedVerdicts, verdictViolation } = decision;
      const base = { exhausted: false, retests: 0, maxRetests: 2, failedRepairs: 0, repairs: 0, localScope: false };
      assert.deepEqual(allowedVerdicts(base), ['RETRY', 'REWRITE', 'SPLIT', 'RETEST', 'REPAIR_TESTS']);
      assert.deepEqual(allowedVerdicts({ ...base, exhausted: true, retests: 2, failedRepairs: 1, localScope: true }), ['SPLIT']);
      // Repairs that finished normally but left the tester unsatisfied still spend the
      // allowance: REPAIR_TESTS is a bounded action, not a loop the supervisor can repeat.
      assert.ok(allowedVerdicts({ ...base, repairs: 1 }).includes('REPAIR_TESTS'));
      assert.ok(!allowedVerdicts({ ...base, repairs: 2 }).includes('REPAIR_TESTS'));
      const task = { description: 'd', solutionVerifyPrompt: 'v' };
      assert.match(verdictViolation({ action: 'RETRY', reason: 'r' }, task, ['RETRY']), /guidance/);
      assert.match(verdictViolation({ action: 'REWRITE', reason: 'r', rewrittenDescription: 'd' }, task, ['REWRITE']), /changed/);
      assert.match(verdictViolation({ action: 'SPLIT', reason: 'r', splitInto: [{ title: 'a' }] }, task, ['SPLIT']), /two parts/);
      assert.match(verdictViolation({ action: 'RETRY', reason: 'r', guidance: 'g' }, task, ['SPLIT']), /one of: SPLIT/);
      assert.equal(verdictViolation({ action: 'RETRY', reason: 'r', guidance: 'g' }, task, ['RETRY']), '');
    });
  } finally {
    tester.runTester = realRunTester;
    decision.decideAfterTest = realDecide;
    decomposition.decideFailureDecomposition = realDecideDecomposition;
    await host.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
