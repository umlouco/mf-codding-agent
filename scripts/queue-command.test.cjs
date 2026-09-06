const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function load(spawn, killTree = () => {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../src/queue/command.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, { exports, process, Buffer, setInterval, clearInterval, setTimeout, clearTimeout,
    require: name => ({ child_process: { spawn }, '../detect': { resolveCoreBinary: () => ({ path: 'core-bin' }),
      workspaceRoot: () => 'workspace with spaces' }, './agents': { killTree } })[name] || {} });
  return exports;
}

for (const outcome of [
  { name: 'pass', code: 0, output: JSON.stringify({ code: 0, output: '3 tests passed', invalid: false }), status: 'ok' },
  { name: 'failed check', code: 1, output: JSON.stringify({ code: 1, output: 'assertion failed', invalid: false }), status: 'error' },
  { name: 'invalid script', code: 0, output: JSON.stringify({ code: 0, output: '', invalid: true, error: 'parse error' }), status: 'error' },
  { name: 'truncated result', code: 0, output: '{"code":0', status: 'error' },
]) {
  test(`recorded command ${outcome.name} uses exact stdin and observed status`, async () => {
    const command = `go test './folder with spaces' && printf '%s\\n' 'literal $value and quotes'`;
    let input = '', invocation;
    const events = [];
    const module = load((binary, args, options) => {
      invocation = { binary, args, options };
      const child = new EventEmitter();
      child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('data', value => { input += value.toString(); });
      setImmediate(() => { child.stdout.end(outcome.output); child.stderr.end(); child.emit('close', outcome.code); });
      return child;
    });
    await module.runVerificationCommand({}, command, (_, event) => events.push(event), () => {});
    assert.equal(input, command);
    assert.ok(!invocation.args.includes(command));
    assert.equal(invocation.options.cwd, 'workspace with spaces');
    assert.equal(invocation.options.windowsHide, true);
    assert.equal(events[0].input.command, command);
    assert.equal(events.at(-1).status, outcome.status);
  });
}

test('cancelling a command cannot produce successful verification evidence', async () => {
  let child;
  const events = [];
  const module = load(() => {
    child = new EventEmitter(); child.pid = 123;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  }, pid => { assert.equal(pid, 123); setImmediate(() => child.emit('close', 0)); });
  await module.runVerificationCommand({}, 'go test ./...', (_, event) => events.push(event), abort => abort());
  assert.equal(events.at(-1).status, 'error');
  assert.match(events.at(-1).output, /cancelled/);
});
