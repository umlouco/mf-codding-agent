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
    Buffer,
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
export { retryBriefing, demandRewrite, escalate, reformatVerdict, queueContextCeiling };
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

test('queue worker initialization retains the configured vision provider', async () => {
  const payload = { providers: [{ id: 'vision', baseURL: 'http://vision' }],
    vision: { providerId: 'vision', model: 'image-model' }, coding: { providerId: 'old' } };
  const { CoreClient } = load('src/core.ts', {
    './providers/payload': { buildCoreConfig: async () => payload },
    './providers/instance': { getStore: () => ({}) },
  });
  const core = Object.create(CoreClient.prototype);
  core.request = async (_, config) => config;
  const config = await core.initialize({ providers: [{ id: 'worker', baseURL: 'http://worker' }], coding: { providerId: 'worker' } });
  assert.equal(config.vision.providerId, 'vision');
  assert.equal(config.coding.providerId, 'worker');
  assert.equal(config.providers.find(p => p.id === 'vision').baseURL, 'http://vision');
  assert.equal(config.providers.find(p => p.id === 'worker').baseURL, 'http://worker');
});

test('editor model proxy forwards image bytes rather than silently dropping them', () => {
  const vscode = {
    LanguageModelTextPart: class { constructor(value) { this.value = value; } },
    LanguageModelDataPart: { image: (data, mime) => ({ data, mime }) },
    LanguageModelChatMessage: { User: content => ({ content }) },
  };
  const { toLmMessages } = load('src/llm/lmProxy.ts', { vscode }, '\nexport { toLmMessages };');
  const messages = toLmMessages([{ role: 'user', content: [
    { type: 'text', text: 'Inspect layout' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ] }]);
  assert.equal(messages[0].content[1].mime, 'image/png');
  assert.equal(messages[0].content[1].data.toString(), 'image');
  assert.throws(() => toLmMessages([{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'http://unfetched/image.png' } },
  ] }]), /inline PNG/);
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
  const current = { ...task(), title: 'Check conditionals', validationReport: JSON.stringify(passingValidation()) };
  const output = { appendLine: () => {} };
  await agents.executeTask({}, output, current, '');
  await agents.superviseTask({}, output, current, 1, 'Correct conditional behavior');
  await agents.demandRewrite({}, output, current, 'Bad selector', '', 'Correct conditional behavior', {});
  await agents.escalate({}, output, current, 'Correct conditional behavior', 'Bad selector', {});
  await agents.reformatVerdict({}, output, current, 'The checks passed.', 'Correct conditional behavior', {});
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

function passingValidation() {
  return {
    conclusion: 'PASS', summary: 'All required states passed',
    implementationEvidence: 'Inspected the handler and its diff',
    behaviorEvidence: 'Executed four transitions; expected and actual values matched',
    checks: [{ kind: 'test', name: 'Four transitions', passed: true,
      evidence: 'node tests/toggle.cjs, workspace root, exit 0, 4 passed' }], remaining: '',
  };
}

test('report parser accepts fences and trailing prose without rewriting evidence', () => {
  const report = passingValidation();
  report.checks[0].evidence += ' {"quoted": "brace } and escaped \""}';
  const raw = JSON.stringify({ validation: report });
  for (const text of [raw, 'Done.\n```json\n' + raw + '\n```\nAll done.', raw + '\nDone.']) {
    const actual = validation.parseExecutorValidation(text, false);
    assert.equal(actual.conclusion, 'PASS');
    assert.equal(actual.checks[0].evidence, report.checks[0].evidence);
  }
});

test('malformed, truncated and nested artifact reports never become PASS', () => {
  const raw = JSON.stringify({ validation: passingValidation() });
  for (const text of [raw.slice(0, -5), '{broken}', JSON.stringify({ artifact: JSON.parse(raw) }), raw + '\n' + raw.slice(0, -5)]) {
    assert.equal(validation.parseExecutorValidation(text, false).conclusion, 'INCOMPLETE');
  }
  assert.equal(validation.parseExecutorValidation(raw, true).conclusion, 'INCOMPLETE');
});

test('PASS requires consistent independent evidence', () => {
  for (const patch of [
    { checks: [] }, { checks: [passingValidation().checks[0], null] },
    { checks: Array(41).fill(passingValidation().checks[0]) }, { remaining: 'Browser not run' }, { behaviorEvidence: '' },
    { checks: [{ kind: 'test', passed: false, evidence: 'exit 1' }] },
    { checks: [{ kind: 'test', passed: true, evidence: '' }] },
    { checks: [{ kind: 'test', passed: 'true', evidence: 'exit 0' }] },
  ]) {
    const raw = JSON.stringify({ validation: { ...passingValidation(), ...patch } });
    assert.equal(validation.parseExecutorValidation(raw, false).conclusion, 'INCOMPLETE');
  }
  assert.equal(validation.storedValidationProblem(JSON.stringify(passingValidation())), '');
  assert.notEqual(validation.storedValidationProblem(''), '');
});

test('unsupported supervisor approval is sent through autonomous recovery', async () => {
  agents.setTestRunner(async () => ({ text: JSON.stringify({
    verdict: 'VERIFIED', feedback: 'Looks good',
    description: 'Preserve code and run the missing behavior check.',
    taskEdits: [], splitInto: [],
  }), stopReason: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const result = await agents.superviseTask({}, { appendLine() {} },
    { ...task(1), validationReport: JSON.stringify({ ...passingValidation(), checks: [] }) }, 1, 'Correct behavior');
  assert.notEqual(result.verdict, 'VERIFIED');
});

test('worker budgets apply to execution and verification, with halted turns unverified', async () => {
  const options = [];
  const runner = async (_, __, role, prompt, opts) => {
    options.push(opts);
    assert.match(prompt, /queue report schema below controls/);
    return { text: JSON.stringify({ validation: passingValidation() }), stopReason: 'max_iterations',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  };
  agents.setTestRunner(runner);
  const result = await agents.executeTask({}, {}, task(), '');
  assert.equal(result.cutOff, true);
  const verifier = load('src/queue/verification.ts', {
    './agents': { ...agents, runOnce: runner }, './validation': validation, './prompts': prompts,
  });
  const checked = await verifier.runVerification({}, {}, task());
  assert.equal(JSON.parse(checked.validationReport).conclusion, 'INCOMPLETE');
  assert.ok(options.every(o => o.maxIterations === 24));
});

test('queue context respects the smaller local or global ceiling', () => {
  for (const [local, global, expected] of [[32768, 200000, 32768], [32768, 8192, 8192],
    [65536, -1, 65536], [NaN, 200000, 32768]]) {
    const module = load('src/queue/agents.ts', {
      vscode: { workspace: { getConfiguration: () => ({ get: () => local }) } },
      '../providers/payload': { contextCeiling: () => global },
    }, '\nexport { queueContextCeiling };');
    assert.equal(module.queueContextCeiling(), expected);
  }
});

test('every supervisor recovery path receives the full original prompt before and at the ceiling', async () => {
  const goal = 'Original request\n' + 'Preserve public APIs. '.repeat(180) + '\nFINAL CONSTRAINT: test both toggle directions.\n';
  const output = { appendLine() {} };
  const current = { ...task(1), title: 'Toggle', validationReport: JSON.stringify(passingValidation()) };
  const promptsSeen = [];
  let replies = [];
  const runner = async (_, __, role, prompt) => {
    assert.equal(role, 'supervisor');
    assert.ok(prompt.includes(goal), 'complete original request including final constraint and whitespace');
    assert.equal(prompt.split(goal).length, 2, 'goal included once per turn');
    assert.match(prompt, /Before rewriting any task description/);
    promptsSeen.push(prompt);
    return { text: JSON.stringify(replies.shift()), stopReason: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  };
  agents.setTestRunner(runner);
  const rewrite = { description: 'Preserve implementation and test both toggle directions.',
    implVerifyPrompt: 'Inspect current handler', solutionVerifyPrompt: 'Run both directions',
    solutionVerifyCommand: '', feedback: 'Recover the missing check' };
  // A bare RETRY exercises the actual caller-to-fallback goal wiring.
  replies = [{ verdict: 'RETRY', feedback: 'Missing check' }, rewrite];
  await agents.superviseTask({}, output, current, 0, goal);
  assert.equal(replies.length, 0);
  // At the ceiling, that same response takes the escalation path.
  replies = [{ verdict: 'RETRY', feedback: 'Missing check' }, { ...rewrite, splitInto: [] }];
  await agents.superviseTask({}, output, { ...current, attempts: 3 }, 3, goal);
  assert.equal(replies.length, 0);
  // Malformed verdict exercises reformatting, which can also return task edits.
  replies = ['The checks passed.', { verdict: 'VERIFIED', feedback: 'All checks passed' }];
  await agents.superviseTask({}, output, current, 0, goal);
  assert.equal(replies.length, 0);
  const monitor = load('src/queue/monitor.ts', {
    './agents': { ...agents, runOnce: runner }, './validation': validation, './prompts': prompts,
  });
  for (const attempts of [1, 3]) {
    replies = [{ action: 'CONTINUE_EXECUTION', reason: 'Useful work continues' }];
    await monitor.reviewProgress({}, output, { ...current, attempts, output: '' }, [], 0, {}, goal);
  }
  assert.equal(promptsSeen.length, 8);
});

test('missing original prompt is explicit rather than inferred from rewritten task text', () => {
  assert.match(prompts.originalGoalContext(''), /\(not recorded\)/);
  assert.match(prompts.originalGoalContext('   '), /do not invent it/);
});
