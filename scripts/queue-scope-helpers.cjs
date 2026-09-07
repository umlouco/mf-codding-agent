const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const vscode = { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } };

function loader(dependencies = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    vm.runInNewContext(outputText, {
      exports, process, Buffer, __dirname, setTimeout, clearTimeout, setInterval, clearInterval,
      require: name => {
        if (name in dependencies) return dependencies[name];
        if (name === 'vscode') return vscode;
        if (name === 'better-sqlite3') throw Error('Use built-in SQLite');
        if (name.startsWith('./')) return load(`src/queue/${name.slice(2)}.ts`);
        return require(name);
      },
    }, { filename: file });
    return exports;
  }
  return load;
}

function keep(shape = 'focused') {
  return { action: 'KEEP', reason: 'One coherent outcome with supporting tests.',
    execution: { shape, reason: 'Implementation, caller and tests form one contract.' },
    verification: { shape: 'focused', reason: 'One behavior with its regression checks.' } };
}

function split(command = '') {
  return { action: 'SPLIT', reason: 'Independent component migrations and shared setup.',
    execution: { shape: 'broad', reason: '120 sibling components can migrate independently.' },
    verification: { shape: 'broad', reason: 'Manual checking of unrelated screens.' },
    requirements: [{ key: 'r1', criterion: 'Migrate components without losing behavior.' }],
    // Deliberately not in dependency order.
    parts: [part('components', ['setup']), part('integration', [], true, command), part('setup', [])] };
}

function part(key, dependsOn = [], integration = false, command = '') {
  return { key, dependsOn, integration, covers: ['r1'], title: key,
    description: `Complete the ${key} slice; retain existing work.`,
    handoff: 'Shared configuration is partially present; inspect diff before continuing.',
    implVerifyPrompt: `Inspect ${key} outcome.`, solutionVerifyPrompt: `Exercise ${key} behavior.`,
    solutionVerifyCommand: command };
}

function fixture(t, overrides = {}, dependencies = {}) {
  let reply = keep();
  const calls = [];
  const agents = { extractJson: text => JSON.parse(text), attemptsExhausted: task => task.attempts >= task.maxAttempts,
    runOnce: async (...args) => { calls.push(args); return { text: JSON.stringify(reply), usage }; }, ...overrides };
  const load = loader({ './agents': agents, './command': {}, './verificationPlanRunner': {}, ...dependencies });
  const { TaskQueue } = load('src/queue/db.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-scope-'));
  const queue = TaskQueue.open(path.join(dir, 'queue.sqlite'));
  t.after(() => {
    queue.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('mf-scope-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  queue.replaceAll([{ title: 'Migrate UI', description: 'Replace Bootstrap across all Vue components.',
    implVerifyPrompt: 'Check the migration.', solutionVerifyPrompt: 'Check every affected screen.' },
    { title: 'Later work', description: 'Must remain after the migration.' }]);
  queue.setRunState('RUNNING'); queue.setMeta('goal', 'Migrate the real application without losing behavior.');
  const { Orchestrator } = load('src/queue/orchestrator.ts');
  const runner = Object.create(Orchestrator.prototype);
  Object.assign(runner, { queue, context: {}, output: { appendLine() {} }, changed() {},
    wakeAfterHandoff() {}, reviewed: new Map(), executionGen: 0, reviewGen: 0, cycle: 0,
    disposed: false, supervising: false });
  return { load, queue, runner, calls, setReply: value => { reply = value; } };
}

const drain = () => new Promise(resolve => setTimeout(resolve, 0));
module.exports = { assert, usage, loader, keep, split, part, fixture, drain };
