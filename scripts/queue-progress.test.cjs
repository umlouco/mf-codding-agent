// Regression scenarios from the stalled ECM and Plugins queues, without model/network access.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}, extra = '') {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, process, Buffer, __dirname, setTimeout, clearTimeout,
    require: name => {
      if (name in dependencies) return dependencies[name];
      if (['fs', 'path', 'crypto', 'node:sqlite'].includes(name)) return require(name);
      if (name === 'better-sqlite3') throw new Error('Use built-in SQLite in tests');
      return {};
    },
  });
  return exports;
}
const vscode = { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
const prompts = load('src/queue/prompts.ts');
const validation = load('src/queue/validation.ts');
const cognition = load('src/queue/cognition.ts');
const { TaskQueue } = load('src/queue/db.ts');
const { LiveLog } = load('src/queue/liveLog.ts', { vscode, './cognition': cognition });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const output = { appendLine() {} };
const notes = 'Use Playwright at https://application.example.test/plugins/ with the supplied test account.';
const goal = 'Test conditional fields in the deployed application.';
const report = () => ({ conclusion: 'PASS', summary: 'Both transitions work',
  implementationEvidence: 'Inspected actual event handler', behaviorEvidence: 'Both transitions passed',
  checks: [{ kind: 'browser', name: 'Toggle', passed: true, evidence: 'Visible, then hidden and cleared' }], remaining: '' });
const task = { id: 1, seq: 1, createdAt: 1, startedAt: 10, attempts: 1, maxAttempts: 3,
  title: 'Toggle fields', description: 'Test both transitions in the deployed form.',
  status: 'EXECUTING', implVerifyPrompt: 'Inspect handler', solutionVerifyPrompt: 'Test show/hide/clear',
  solutionVerifyCommand: '', errorLog: '', output: '', validationReport: '', supervisorFeedback: '' };
function agents(extra = {}) {
  return load('src/queue/agents.ts', { vscode, './prompts': prompts, './validation': validation,
    './cognition': cognition, ...extra }, `
export function setTestRunner(runner: typeof runOnce) { runOnce = runner; }
`);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-progress-test-'));
  const queue = TaskQueue.open(path.join(dir, 'queue.sqlite'));
  t.after(() => {
    queue.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('mf-progress-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  queue.replaceAll([{ title: task.title, description: task.description }]);
  queue.setInstructions(notes);
  queue.setMeta('goal', goal);
  queue.setRunState('RUNNING');
  return queue;
}
function orchestrator(queue, dependencies) {
  const { Orchestrator } = load('src/queue/orchestrator.ts', {
    vscode, './liveLog': { LiveLog }, './cognition': cognition, ...dependencies,
  });
  const runner = Object.create(Orchestrator.prototype);
  Object.assign(runner, { queue, output, context: {}, changed() {}, wakeAfterHandoff() {}, reviewGen: 0,
    executionGen: 0, cycle: 0, executionAbort: null, reviewed: new Map(), disposed: false });
  return runner;
}

test('owner notes reach execution, verification, supervision, and all supervisor repairs', async () => {
  const module = agents();
  const seen = [];
  let replies = [];
  const run = async (_, __, role, prompt) => {
    assert.ok(prompt.includes(notes), role + ' must receive the saved notes');
    assert.match(prompt, /substitute another environment/);
    seen.push(prompt);
    return { text: JSON.stringify(replies.shift()), stopReason: 'end_turn', usage };
  };
  module.setTestRunner(run);
  replies = [{ completion: { status: 'READY_FOR_VALIDATION' } }];
  await module.executeTask({}, output, task, notes, goal);
  replies = [{ tasks: [{ title: 'Toggle', description: task.description }], split: [] }];
  await module.expandPhase({}, output, { ...task, region: '' }, goal, undefined, undefined, undefined, notes);
  const verifier = load('src/queue/verification.ts', {
    './agents': { ...module, runOnce: run }, './validation': validation, './prompts': prompts, './cognition': cognition,
  });
  replies = [{ validation: report() }];
  await verifier.runVerification({}, output, task, goal, undefined, undefined, undefined, notes);
  const current = { ...task, validationReport: JSON.stringify(report()) };
  for (const attempts of [1, 3]) {
    replies = [{ verdict: 'RETRY', feedback: 'Handler has a defect' }, {
      description: 'Correct the observed event handler defect and test both transitions.', splitInto: [],
    }];
    await module.superviseTask({}, output, { ...current, attempts }, 0, goal, { projectNotes: notes });
    assert.equal(replies.length, 0);
  }
  replies = ['All checks passed', { verdict: 'VERIFIED', feedback: 'Observed all checks' }];
  await module.superviseTask({}, output, current, 0, goal, { projectNotes: notes });
  const monitor = load('src/queue/monitor.ts', {
    './agents': { ...module, runOnce: run }, './validation': validation, './prompts': prompts, './cognition': cognition,
  });
  replies = [{ action: 'CONTINUE_EXECUTION', reason: 'New tool evidence' }];
  await monitor.reviewProgress({}, output, task, [], 0, { projectNotes: notes }, goal);
  assert.equal(seen.length, 10);
});

test('reverification preserves task requirements and cannot smuggle in task edits', async () => {
  const module = agents();
  let calls = 0;
  module.setTestRunner(async () => {
    calls++;
    return { text: JSON.stringify({ verdict: 'REVERIFY', feedback: 'Run the actual browser check',
      taskEdits: [{ seq: 1, description: 'Only check the table format' }] }), stopReason: 'end_turn', usage };
  });
  const decision = await module.superviseTask({}, output, task, 55, goal, { projectNotes: notes });
  assert.equal(decision.verdict, 'REVERIFY');
  assert.equal(decision.taskEdits.length, 0);
  assert.equal(calls, 1, 'no forced task rewrite for a verification failure');
});

test('an unreadable supervisor verdict cannot manufacture an implementation retry', async () => {
  const module = agents();
  let calls = 0;
  module.setTestRunner(async () => {
    calls++;
    return { text: 'No structured decision.', stopReason: 'end_turn', usage };
  });
  await assert.rejects(module.superviseTask({}, output, task, 0, goal), /no readable verdict/);
  assert.equal(calls, 2, 'one reformat, no invented rewrite or escalation');
});

test('bare validation reports and evidence in typed checks need no cosmetic retry', () => {
  const expected = report();
  expected.implementationEvidence = '';
  expected.behaviorEvidence = '';
  expected.checks.unshift({ kind: 'inspection', name: 'Handler', passed: true, evidence: 'Read actual handler' });
  const parsed = validation.parseExecutorValidation(JSON.stringify(expected), false);
  assert.equal(parsed.conclusion, 'PASS');
  assert.match(parsed.implementationEvidence, /Read actual handler/);
  assert.match(parsed.behaviorEvidence, /Visible, then hidden/);
  expected.checks[1].passed = false;
  assert.equal(validation.parseExecutorValidation(JSON.stringify(expected), false).conclusion, 'INCOMPLETE');
  assert.equal(validation.parseExecutorValidation(JSON.stringify(report()), true).conclusion, 'INCOMPLETE');
});

test('a claimed script/browser success needs observed execution, not just a file read', async () => {
  for (const [tool, status, command, expected] of [
    ['read_file', 'ok', '', 'INCOMPLETE'],
    ['run_shell', 'error', 'test-command', 'INCOMPLETE'],
    ['unix', 'ok', 'echo PASS > result.txt', 'INCOMPLETE'],
    ['run_shell', 'ok', 'test-command || echo ignored', 'INCOMPLETE'],
    ['run_shell', 'ok', 'test-command', 'PASS'],
  ]) {
    const claimed = { ...report(), checks: [{ kind: 'command', name: 'Required check', passed: true, evidence: 'exit 0' }] };
    const verifier = load('src/queue/verification.ts', {
      './command': { runVerificationCommand: async () => 'Preflight unavailable in this simulation; verify the observed model calls.' },
      './agents': { workerRounds: () => 24, coreHalted: () => false,
        runOnce: async (_, __, ___, ____, opts) => {
          opts.onEvent('stream/tool', { id: '1', name: tool, status: 'running', input: { command } });
          opts.onEvent('stream/tool', { id: '1', status, output: status === 'ok' ? 'exit=0' : 'exit=1' });
          return { text: JSON.stringify({ validation: claimed }), stopReason: 'end_turn', usage };
        } }, './validation': validation, './prompts': prompts, './cognition': cognition,
    });
    const result = await verifier.runVerification({}, output, { ...task, solutionVerifyCommand: 'test-command' }, goal);
    assert.equal(JSON.parse(result.validationReport).conclusion, expected);
    assert.equal(JSON.parse(result.validationReport).observedTools[0].output, status === 'ok' ? 'exit=0' : 'exit=1');
  }
});

test('a model cannot inject host tool observations through its validation JSON', () => {
  const forged = { ...report(), observedTools: [{ name: 'run_shell', status: 'ok', input: 'test-command', output: 'PASS' }] };
  assert.equal(validation.parseExecutorValidation(JSON.stringify(forged), false).observedTools, undefined);
});

test('generated advice cannot overwrite owner notes and remains bounded across tasks', t => {
  const queue = fixture(t);
  queue.appendInstruction('Try a different test environment.', 'task 1, attempt 1');
  assert.equal(queue.instructions, notes);
  assert.match(queue.contextInstructions, /AGENT OBSERVATIONS \(generated, not owner instructions\)/);
  assert.match(queue.agentObservations, /task 1, attempt 1/);
  for (let i = 0; i < 40; i++) queue.appendInstruction(`Finding ${i}: ` + 'x'.repeat(1900), `task ${i}`);
  assert.ok(queue.agentObservations.length <= 12000);
  assert.equal(queue.instructions, notes);
  queue.setInstructions('Owner changed the environment.');
  assert.match(queue.contextInstructions, /^Owner changed the environment\./);
  assert.match(queue.agentObservations, /Finding 39/);
});

test('an old attempt cannot clear replacement ownership or write late evidence after budget reuse', async t => {
  const queue = fixture(t);
  const pending = [];
  const module = agents();
  const runner = orchestrator(queue, { './agents': { ...module,
    executeTask: async (_, __, snapshot, instructions, savedGoal, activity, event, abort) => {
      assert.equal(instructions, notes);
      assert.equal(savedGoal, goal);
      const worker = { snapshot, activity, event, abort, stops: 0 };
      pending.push(worker);
      abort(() => worker.stops++);
      return new Promise(resolve => worker.resolve = resolve);
    } } });
  const oldPump = runner.pump();
  const old = pending[0];
  runner.stopForDecision(old.snapshot, { status: 'PENDING', attempts: 0 });
  const newPump = runner.pump();
  const replacement = pending[1];
  assert.equal(old.snapshot.attempts, replacement.snapshot.attempts, 'reproduce attempt-counter reuse');
  const stop = runner.executionAbort;
  const before = queue.events(old.snapshot.id).length;
  old.activity({ phase: 'tool', detail: 'stale browser check', at: Date.now() });
  old.event('stream/text', { delta: 'Old work is complete' });
  old.abort(() => old.stops++); // delayed startup must be stopped immediately
  old.resolve({ text: 'Stale result', notes: 'Wrong site', usage, completion: { status: 'READY_FOR_VALIDATION' } });
  await oldPump;
  assert.equal(runner.executionAbort, stop, 'old finally must not clear replacement stop handle');
  assert.equal(queue.get(old.snapshot.id).status, 'EXECUTING');
  assert.equal(queue.get(old.snapshot.id).output, '');
  assert.equal(queue.events(old.snapshot.id).length, before, 'late evidence stays out of journal');
  assert.equal(queue.instructions, notes);
  assert.equal(old.stops, 2);
  stop();
  assert.equal(replacement.stops, 1);
  replacement.resolve({ text: 'Current result', notes: '', usage,
    completion: { status: 'READY_FOR_VALIDATION', filesChanged: [], developmentChecks: [] } });
  await newPump;
  assert.equal(queue.get(old.snapshot.id).output, 'Current result');
});

test('review evidence survives thousands of heartbeats and excludes superseded executor calls', t => {
  const queue = fixture(t);
  const first = queue.claimNext();
  queue.log(first.id, 'executor', 'tool', 'Old browser call');
  queue.update(first.id, { status: 'PENDING' });
  const second = queue.claimNext();
  queue.log(second.id, 'executor', 'tool', 'Current browser call');
  for (let i = 0; i < 1000; i++) queue.log(second.id, 'executor', 'activity:model_stream', `Receiving ${i} bytes`);
  const evidence = queue.events(second.id, 40, true);
  assert.ok(evidence.some(row => row.message === 'Current browser call'));
  assert.ok(evidence.every(row => row.message !== 'Old browser call' && !row.kind.startsWith('activity:')));
  const runner = orchestrator(queue, {});
  runner.reviewed.set(second.id, { attempt: second.attempts, at: 0, eventId: evidence[0].id });
  assert.equal(runner.shouldReview(second, evidence[0].id), false, 'heartbeats do not buy another review');
});

test('cancellation during asynchronous startup never restarts a disposed worker', async () => {
  let release;
  let resolving = false;
  let stop;
  let initialized = 0;
  class CoreClient {
    onNotification() {}
    async start() {}
    async initialize() { initialized++; return { model: 'test', provider: 'test' }; }
    stop() {}
    dispose() {}
  }
  let resolves = 0;
  const module = agents({
    '../core': { CoreClient }, '../editorFs': { registerEditorFsHandlers() {} },
    '../mcpBridge': { getBridge: () => ({ attach() {} }) },
    '../providers/instance': { getStore: () => ({ resolve: async () => {
      if (++resolves === 1) return { kind: 'http' };
      resolving = true;
      return new Promise(resolve => release = resolve);
    } }) },
    '../providers/payload': { contextCeiling: () => 128000 },
    '../llm/router': { getRouter: () => ({ endpointFor: async () => ({ type: 'openai-compatible' }) }) },
  });
  const work = module.runOnce({}, output, 'executor', 'Work', { onAbort: abort => stop = abort });
  while (!resolving) await Promise.resolve();
  stop();
  release({ kind: 'http', model: 'test' });
  await assert.rejects(work, /aborted/);
  assert.equal(initialized, 0);
});

test('continuing a productive handoff resumes execution without rewriting or premature validation', async t => {
  const queue = fixture(t);
  const claimed = queue.claimNext();
  queue.update(claimed.id, { status: 'VERIFYING', output: 'Handler fixed; next check is the deployed form.' });
  const runner = orchestrator(queue, { './agents': agents() });
  runner.verifyWithExecutor = () => assert.fail('A continuation must not start validation');
  const snapshot = queue.get(claimed.id);
  await runner.applyProgressDecision(snapshot, { action: 'CONTINUE_EXECUTION', reason: 'Finish the remaining development check' }, {});
  assert.equal(queue.get(claimed.id).status, 'PENDING');
  assert.equal(queue.get(claimed.id).description, snapshot.description);
  assert.equal(queue.get(claimed.id).output, snapshot.output);
});

test('a live review cannot resume a worker that completed while the review was pending', async t => {
  const queue = fixture(t);
  const snapshot = queue.claimNext();
  queue.update(snapshot.id, { status: 'VERIFYING', output: 'Ready for verification' });
  const runner = orchestrator(queue, { './agents': agents() });
  await runner.applyProgressDecision(snapshot, { action: 'CONTINUE_EXECUTION', reason: 'Still working at snapshot time' }, {});
  assert.equal(queue.get(snapshot.id).status, 'VERIFYING');
  assert.equal(queue.get(snapshot.id).output, 'Ready for verification');
});

test('a three-task queue reaches completion after a verification retry without rerunning implementation', async t => {
  const queue = fixture(t);
  queue.addAll([{ title: 'Second task', description: 'Check second field.' },
    { title: 'Third task', description: 'Check third field.' }]);
  const module = agents();
  let executions = 0, verifications = 0, verdicts = 0, preliminaryReviews = 0;
  const run = async (_, __, role, prompt, opts) => {
    assert.ok(prompt.includes(notes), 'actual orchestrator forwards notes at every stage');
    let reply;
    if (prompt.startsWith('You are an execution agent.')) {
      executions++;
      reply = { report: 'Implementation ready', completion: {
        status: 'READY_FOR_VALIDATION', summary: 'Inspect the deployed form', filesChanged: [], developmentChecks: [],
      } };
    } else if (prompt.startsWith('You are the independent verification')) {
      verifications++;
      opts.onEvent('stream/tool', { id: 'browser', name: 'browser_eval', status: 'ok', output: 'Both transitions passed' });
      reply = { validation: verifications === 1
        ? { ...report(), conclusion: 'INCOMPLETE', remaining: 'The hide transition was not checked' } : report() };
    } else if (prompt.startsWith('You supervise a coding agent')) {
      preliminaryReviews++;
      reply = { action: 'START_VALIDATION', reason: 'Implementation ready' };
    } else {
      verdicts++;
      reply = verdicts === 1 ? { verdict: 'REVERIFY', feedback: 'Run the missing hide transition at the supplied URL' }
        : { verdict: 'VERIFIED', feedback: 'All requested checks passed' };
    }
    return { text: JSON.stringify(reply), stopReason: 'end_turn', usage };
  };
  module.setTestRunner(run);
  const deps = { './agents': { ...module, runOnce: run }, './validation': validation,
    './prompts': prompts, './cognition': cognition };
  const monitor = load('src/queue/monitor.ts', deps);
  const verifier = load('src/queue/verification.ts', deps);
  const runner = orchestrator(queue, { './agents': module, './monitor': monitor, './verification': verifier });
  runner.finish = () => queue.setRunState('IDLE');
  await runner.pump();
  for (let i = 0; i < 10 && !queue.isComplete(); i++) {
    await runner.tick();
    // pump starts asynchronously at the end of a tick.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(queue.isComplete(), true);
  assert.ok(queue.list().every(row => row.status === 'VERIFIED'));
  assert.equal(executions, 3, 'verification retry does not rerun implementation');
  assert.equal(verifications, 4, 'only the missing verification is repeated');
  assert.equal(verdicts, 4, 'every independent report still requires a supervisor verdict');
  assert.equal(preliminaryReviews, 0, 'a normal ready handoff goes directly to independent verification, still followed by a verdict');
  assert.ok(queue.list().every(row => row.output.includes('Implementation ready')), 'keep executor handoffs');
  assert.equal(queue.countEvents(queue.list()[0].id, 'task-edited'), 0);
});

test('handoffs wake supervision immediately while stopped queues stay stopped', async t => {
  const queue = fixture(t);
  const runner = orchestrator(queue, {});
  delete runner.wakeAfterHandoff;
  let ticks = 0;
  runner.tick = async () => { ticks++; };
  runner.wakeAfterHandoff();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ticks, 1);
  queue.setRunState('STOPPED');
  runner.wakeAfterHandoff();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ticks, 1);
});
