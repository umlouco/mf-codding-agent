// Run with: node --test scripts/cli-tools.test.cjs
// Exercise CLI turn arguments without launching Claude or making model requests.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

function loadCli(spawn) {
  const file = 'src/queue/claudeCli.ts';
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const dependencies = {
    child_process: { spawn },
    readline: require('node:readline'),
    vscode: { workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) } },
    '../detect': { workspaceRoot: () => 'test-workspace' },
    './agents': { killTree: () => {} },
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    Buffer,
    process,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return exports;
}

for (const role of ['supervisor', 'executor', 'planner']) {
  test(`${role} CLI turns retain available tools and configured controls`, async () => {
    let call;
    const cli = loadCli((bin, args, options) => {
      const proc = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      call = { bin, args: Array.from(args), options, input: '' };
      proc.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
      setImmediate(() => {
        proc.stdout.end(JSON.stringify({
          type: 'result', result: 'Finished', stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0.01,
        }) + '\n');
        proc.stderr.end();
        proc.emit('close', 0);
      });
      return proc;
    });

    const result = await cli.runClaudeCliTurn({ appendLine: () => {} }, role, {
      model: 'configured-model', effort: 'high', profile: { extra: { cliPath: 'custom-claude' } },
    }, 'Review the supplied evidence.', {});

    assert.equal(call.bin, 'custom-claude');
    assert.ok(!call.args.includes('--tools'), 'the role must not remove available CLI tools');
    assert.ok(!call.args.includes('--allowedTools'), 'the role must not restrict the tool set');
    assert.ok(!call.args.includes('--disallowedTools'), 'the role must not exclude tools');
    assert.equal(call.args[0], '-p');
    for (const [flag, value] of [
      ['--output-format', 'stream-json'], ['--permission-mode', 'bypassPermissions'],
      ['--model', 'configured-model'], ['--effort', 'high'], ['--max-budget-usd', '2'],
    ]) {
      assert.ok(call.args.includes(flag), `${flag} remains configured`);
      assert.equal(call.args[call.args.indexOf(flag) + 1], value);
    }
    assert.ok(call.args.includes('--strict-mcp-config'));
    assert.ok(call.args.includes('--verbose'));
    assert.ok(call.args.includes('--include-partial-messages'));
    assert.equal(call.options.cwd, 'test-workspace');
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.input, 'Review the supplied evidence.');
    assert.ok(!call.args.includes(call.input), 'prompt is passed via stdin');
    const suffix = call.args[call.args.indexOf('--append-system-prompt') + 1];
    assert.doesNotMatch(suffix, /no tools available/i);
    if (role === 'supervisor') {
      assert.match(suffix, /supplied task journal/);
      assert.match(suffix, /use available tools when needed/);
      assert.match(suffix, /separate formal verifier supplies the independent verification report/);
    } else if (role === 'executor') {
      assert.match(suffix, /task queue worker/);
      assert.match(suffix, /independently check verification tasks/);
    } else {
      assert.match(suffix, /Planner/);
      assert.match(suffix, /read-only inspection tools/);
    }
    assert.equal(result.text, 'Finished');
    assert.equal(result.usage.input, 5);
    assert.equal(result.usage.output, 2);
  });
}
