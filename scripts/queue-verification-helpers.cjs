const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function verificationDependencies(options = {}) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const exports = {}; cache.set(name, exports);
    const source = fs.readFileSync(path.join(__dirname, '../src/queue', name + '.ts'), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022 } }).outputText, { exports,
      require: dependency => dependency === 'crypto' ? require('node:crypto') :
        dependency.startsWith('./') ? load(dependency.slice(2)) : {} });
    return exports;
  }
  return { './verificationPlan': load('verificationPlan'), './verificationPlanRunner': { VerificationSession: class {
    constructor(_, __, observe) { this.observe = observe; this.capabilities = ['unix', 'browser_eval', 'read_file']
      .map(name => ({ name, description: name, inputSchema: {} })); }
    async start() {}
    async execute(plan) { return plan.steps.map(step => {
      const result = options.result ? options.result(step) : { output: step.kind === 'shell' ? 'exit=0, 4 passed' : 'true', isError: false, meta: { exitCode: 0 } };
      this.observe('stream/tool', { id: step.id, name: step.kind === 'shell' ? 'unix' : step.name,
        input: step.kind === 'shell' ? { command: step.command } : step.input, status: result.isError ? 'error' : 'ok', output: result.output });
      return load('verificationPlan').verificationReceipt(step, result);
    }); }
    stop() {}
  } } };
}
function verificationPlanReply(command = '', browser = false) {
  return { version: 1, commandDisposition: command ? 'retained' : 'none', reason: '', preservedAssertions: [], remaining: [],
    steps: [browser ? { id: 'states', kind: 'tool', name: 'browser_eval', input: { expression: 'true' }, expect: { jsonEquals: true },
      requirement: 'Both directions satisfy assigned behavior', dependsOn: [] } :
      { id: 'states', kind: 'shell', requirement: 'Both directions satisfy assigned behavior', command: command || 'npm test', expectExitCode: 0, dependsOn: [] }] };
}
module.exports = { verificationDependencies, verificationPlanReply };
