// Run with: node --test scripts/queue-retry.test.cjs
// Load the queue logic without starting VS Code, workers, or model requests.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function load(file, dependencies = {}, extra = '') {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => dependencies[name] ?? {},
  }, { filename: file });
  return exports;
}

const prompts = load('src/queue/prompts.ts');
const validation = load('src/queue/validation.ts');
const agents = load('src/queue/agents.ts', {
  './prompts': prompts,
  './validation': validation,
  vscode: { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } },
}, `
export { retryBriefing, demandRewrite, escalate, reformatVerdict };
export function setTestRunner(runner: typeof runOnce) { runOnce = runner; }
`);
const { Orchestrator } = load('src/queue/orchestrator.ts', { './agents': agents });
const task = (attempts = 3) => ({
  id: 1, seq: 1, status: 'EXECUTING', attempts, maxAttempts: 3,
  description: 'Implement conditional visibility and independently verify all four required states.',
  implVerifyPrompt: 'Inspect the implementation', solutionVerifyPrompt: 'Check four states',
  solutionVerifyCommand: '', errorLog: '[attempt 3] Invalid selector syntax',
  supervisorFeedback: 'Use the supplied script intact and return a plain object.',
});

test('fresh attempt budget retains recovery evidence and feedback', () => {
  const briefing = agents.retryBriefing(task(1));
  assert.match(briefing, /Invalid selector syntax/);
  assert.match(briefing, /Use the supplied script intact/);
  assert.equal(agents.retryBriefing({ ...task(1), errorLog: '', supervisorFeedback: '' }), '');
});

async function apply(current, decision) {
  const patches = [];
  const runner = Object.create(Orchestrator.prototype);
  runner.queue = { get: () => current, log: () => {} };
  runner.log = () => {};
  runner.stopForDecision = (_, patch) => { patches.push(patch); return true; };
  await runner.applyProgressDecision(current, { reason: 'Recover from syntax errors', ...decision }, {});
  return patches;
}

test('live task rewrite resets an exhausted budget, but preserves an unspent budget', async () => {
  const decision = {
    action: 'STOP_AND_REWRITE_TASK',
    rewrittenDescription: 'Preserve the working implementation. Run the provided combined browser script and report all four states.',
  };
  assert.equal((await apply(task(), decision))[0].attempts, 0);
  assert.equal((await apply(task(2), decision))[0].attempts, undefined);
});

test('live validation rewrite resets an exhausted budget', async () => {
  const patches = await apply(task(), {
    action: 'STOP_AND_REWRITE_VALIDATION', solutionVerifyPrompt: 'Execute the combined script intact.',
  });
  assert.equal(patches[0].attempts, 0);
  assert.equal(patches[0].status, 'PENDING');
});

test('unchanged task or verification cannot buy a fresh budget', async () => {
  assert.equal((await apply(task(), {
    action: 'STOP_AND_REWRITE_TASK', rewrittenDescription: task().description,
  })).length, 0);
  assert.equal((await apply(task(), {
    action: 'STOP_AND_REWRITE_VALIDATION', solutionVerifyPrompt: task().solutionVerifyPrompt,
  })).length, 0);
});

test('rendered worker and recovery prompts contain valid JSON examples', async () => {
  const captured = [];
  const response = {
    ...JSON.parse(prompts.executorExample), ...JSON.parse(prompts.verificationExample),
    verdict: 'VERIFIED', feedback: 'Checks passed', taskEdits: [], splitInto: [],
    action: 'START_VALIDATION', reason: 'Implementation is ready for independent checks',
    edits: [], adds: [], deletes: [],
    description: 'Preserve working code and run the provided script with an explicit return.',
  };
  const runner = async (_, __, role, prompt) => {
    captured.push({ role, prompt });
    return { text: JSON.stringify(response), stopReason: '', usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    } };
  };
  agents.setTestRunner(runner);
  const current = { ...task(), title: 'Check conditionals', validationReport: JSON.stringify(response.validation) };
  const output = { appendLine: () => {} };
  await agents.executeTask({}, output, current, '');
  await agents.superviseTask({}, output, current, 1, 'Correct conditional behavior');
  await agents.demandRewrite({}, output, current, 'Bad selector', '', {});
  await agents.escalate({}, output, current, 'Correct conditional behavior', 'Bad selector', {});
  await agents.reformatVerdict({}, output, current, 'The checks passed.', {});
  await agents.editTasks({}, output, [current], 'Clarify the check');
  const verifier = load('src/queue/verification.ts', {
    './agents': { ...agents, runOnce: runner }, './validation': validation, './prompts': prompts,
  });
  await verifier.runVerification({}, output, current);
  const monitor = load('src/queue/monitor.ts', {
    './agents': { ...agents, runOnce: runner }, './validation': validation, './prompts': prompts,
  });
  await monitor.reviewProgress({}, output, { ...current, output: '' }, [], 0, {}, 'Correct conditional behavior');
  assert.equal(captured.length, 8);
  for (const { prompt } of captured) {
    assert.ok(!prompt.includes('undefined'), 'unresolved prompt interpolation');
    const examples = prompt.match(/^\{\n[\s\S]*?^\}/gm) ?? [];
    assert.ok(examples.length > 0, 'expected an output example');
    for (const example of examples) assert.doesNotThrow(() => JSON.parse(example), example);
  }
  const completion = validation.parseCompletionClaim(prompts.executorExample);
  assert.equal(completion.status, 'NEEDS_MORE_WORK');
  const report = validation.parseExecutorValidation(prompts.verificationExample, false);
  assert.equal(report.conclusion, 'INCOMPLETE');
});
