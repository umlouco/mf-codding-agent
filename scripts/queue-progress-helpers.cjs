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
      if (/^\.\/(orchestrator|scope)/.test(name)) return load('src/queue/' + name.slice(2) + '.ts', dependencies);
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
    scopeWatch: () => ({ preflight: async () => true, observe() {}, close() {} }),
    executionGen: 0, cycle: 0, executionAbort: null, reviewed: new Map(), disposed: false });
  return runner;
}
module.exports = { fs, os, path, vm, assert, test, ts, load, vscode, prompts, validation, cognition, TaskQueue, LiveLog, usage, output, notes, goal, report, task, agents, fixture, orchestrator };
