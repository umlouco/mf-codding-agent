// Load the real modular agent graph with one cache and explicit provider/RPC doubles.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadQueueAgents(dependencies = {}) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(__dirname, '..', 'src', 'queue', `${name}.ts`);
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports = {};
    cache.set(name, exports);
    vm.runInNewContext(outputText, {
      exports, process, Buffer, setTimeout, clearTimeout,
      require: dependency => {
        if (dependency in dependencies) return dependencies[dependency];
        if (/^\.\/(agent|scope)/.test(dependency)) return load(dependency.slice(2));
        if (['./prompts', './validation', './cognition'].includes(dependency)) return load(dependency.slice(2));
        if (dependency === 'crypto') return require('node:crypto');
        return {};
      },
    }, { filename: file });
    return exports;
  }
  const agents = load('agents');
  // Existing regression suites inspect these internals; no production test hooks are needed.
  for (const name of ['agentRuntime', 'agentHistory', 'agentSupervisorRepair', 'agentSplit']) {
    const source = load(name);
    for (const key of Object.keys(source)) {
      if (!(key in agents)) Object.defineProperty(agents, key, { enumerable: true, get: () => source[key] });
    }
  }
  agents.setTestRunner = runner => { load('agentRuntime').runOnce = runner; };
  return agents;
}

module.exports = { loadQueueAgents };
