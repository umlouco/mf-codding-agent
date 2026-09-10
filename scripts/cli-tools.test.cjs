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

function loadCli(spawn, overrides = {}, runtime = { getuid: () => 1000, geteuid: () => 1000 }) {
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
    './registry': { getActiveQueue: () => undefined },
    './testingEnvironment': { redactTestingSecrets: text => text },
    '../providers/instance': {},
    ...overrides,
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    Buffer,
    process: { ...process, ...runtime },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return exports;
}

for (const runtime of [
  { platform: 'linux', getuid: () => 0, geteuid: () => 0 },
  { platform: 'darwin', getuid: () => 0, geteuid: () => 0 },
  { platform: 'linux', getuid: () => 1000, geteuid: () => 0 },
  { platform: 'linux', getuid: () => 0, geteuid: () => 1000 },
  { platform: 'win32', getuid: undefined, geteuid: undefined },
]) {
  for (const [role, opts] of [
    ['planner', {}], ['supervisor', {}], ['executor', {}],
    ['supervisor', { allowTestEdits: true }],
    ['planner', { formatOnly: true }],
    ['supervisor', { formatOnly: true }],
    ['executor', { formatOnly: true, verificationOnly: true }],
  ]) {
    const root = runtime.getuid?.() === 0 || runtime.geteuid?.() === 0;
    test(`${role} starts with ${JSON.stringify(opts)} on ${runtime.platform}, uid=${runtime.getuid?.()}, euid=${runtime.geteuid?.()}`, async () => {
      let invocation;
      const plan = '[{"title":"Audit publishing readiness","description":"Inspect plugin","regionPaths":["."]}]';
      const cli = loadCli((bin, args, options) => {
        invocation = { args: Array.from(args), options, input: '' };
        const proc = new EventEmitter();
        proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
        proc.stdin.on('data', chunk => { invocation.input += chunk; });
        setImmediate(() => {
          if (root && args[args.indexOf('--permission-mode') + 1] === 'bypassPermissions') {
            proc.stdout.end();
            proc.stderr.end('--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons');
            proc.emit('close', 1);
          } else {
            proc.stdout.end(JSON.stringify({ type: 'result', result: plan, stop_reason: 'end_turn' }) + '\n');
            proc.stderr.end(); proc.emit('close', 0);
          }
        });
        return proc;
      }, {}, runtime);
      const result = await cli.runClaudeCliTurn({ appendLine() {} }, role, { model: 'configured' }, 'Plan publishing checks.', opts);
      assert.equal(result.text, plan);
      assert.equal(invocation.input, 'Plan publishing checks.');
      const args = invocation.args;
      assert.equal(args[args.indexOf('--permission-mode') + 1], root || opts.formatOnly || role === 'planner' ? 'dontAsk' : 'bypassPermissions');
      assert.ok(!args.includes('--dangerously-skip-permissions'));
      assert.equal(invocation.options.env.MFAGENT_QUEUE_ROLE, opts.verificationOnly ? 'validator' : opts.allowTestEdits ? 'supervisor-repair' : role);
      if (opts.formatOnly) {
        assert.equal(args[args.indexOf('--tools') + 1], '');
        assert.ok(!args.includes('--allowedTools'));
      } else if (role === 'planner') {
        const inspection = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
        assert.deepEqual(args[args.indexOf('--tools') + 1].split(','), inspection);
        assert.deepEqual(args[args.indexOf('--allowedTools') + 1].split(','), inspection);
      } else if (root) {
        const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
        for (const name of ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) {
          assert.ok(allowed.includes(name), `${name} has an explicit unattended approval`);
        }
        assert.ok(!allowed.includes('*'), 'unanchored wildcard approvals are ignored by Claude');
        assert.ok(!allowed.includes('mcp__mfagent__*'), 'only approve MCP when configured');
        assert.ok(!args.includes('--tools'), 'retain the available tool set');
      }
    });
  }
}

for (const role of ['supervisor', 'executor', 'planner']) {
  test(`${role} CLI turns retain role-appropriate tools and configured controls`, async () => {
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
    if (role === 'planner') {
      assert.deepEqual(call.args[call.args.indexOf('--tools') + 1].split(','), ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
      assert.ok(call.args.includes('--allowedTools'), 'planner inspection runs unattended');
    } else {
      assert.ok(!call.args.includes('--tools'), 'implementation-capable roles retain their available tools');
      assert.ok(!call.args.includes('--allowedTools'));
    }
    assert.ok(!call.args.includes('--disallowedTools'), 'the role must not exclude tools');
    assert.equal(call.args[0], '-p');
    for (const [flag, value] of [
      ['--output-format', 'stream-json'], ['--permission-mode', role === 'planner' ? 'dontAsk' : 'bypassPermissions'],
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
      assert.match(suffix, /inspection-only supervisor turn/);
      assert.match(suffix, /does not replace independent verification/);
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

for (const formatOnly of [false, true]) {
  test(`supervisor CLI repair authority remains explicit with formatOnly=${formatOnly}`, async () => {
    let args;
    const cli = loadCli((_bin, actualArgs) => {
      args = actualArgs;
      const proc = new EventEmitter();
      proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
      setImmediate(() => {
        proc.stdout.end(JSON.stringify({ type: 'result', result: 'Repair handoff', stop_reason: 'end_turn' }) + '\n');
        proc.stderr.end(); proc.emit('close', 0);
      });
      return proc;
    });
    await cli.runClaudeCliTurn({ appendLine() {} }, 'supervisor', { profile: { extra: {} } },
      'Repair the reported test defect.', { allowTestEdits: true, formatOnly });
    const flag = formatOnly ? '--system-prompt' : '--append-system-prompt';
    const system = args[args.indexOf(flag) + 1];
    assert.match(system, /engineering supervisor/);
    if (formatOnly) {
      assert.match(system, /tools are unavailable/);
      assert.doesNotMatch(system, /use scoped editing tools/);
      assert.equal(args[args.indexOf('--tools') + 1], '');
    } else {
      assert.match(system, /dedicated supervisor test-repair turn/);
      assert.match(system, /Fresh independent verification must follow/);
      assert.doesNotMatch(system, /This is an inspection-only supervisor turn/);
    }
  });
}

test('CLI tool evidence retains streamed arguments and distinguishes failed results', async () => {
  const events = [];
  const cli = loadCli(() => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    setImmediate(() => {
      const lines = [
        { type: 'stream_event', event: { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'shell-1', name: 'Bash', input: {} } } },
        ...['{"command":', '"go test ./..."}'].map(partial_json => ({ type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } } })),
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell-1',
          is_error: true, content: 'Tests failed' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'shell-2', name: 'Bash',
          input: { command: 'go test ./...' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell-2', content: 'ok' }] } },
        { type: 'result', result: 'Finished', stop_reason: 'end_turn' },
      ];
      proc.stdout.end(lines.map(JSON.stringify).join('\n') + '\n');
      proc.stderr.end(); proc.emit('close', 0);
    });
    return proc;
  });
  await cli.runClaudeCliTurn({ appendLine() {} }, 'executor', { model: 'configured', profile: { extra: {} } },
    'Run verification.', { onEvent: (method, params) => events.push({ method, ...params }) });
  assert.equal(events.find(e => e.id === 'shell-1' && e.input?.command).input.command, 'go test ./...');
  assert.equal(events.find(e => e.id === 'shell-1' && e.output).status, 'error');
  assert.equal(events.find(e => e.id === 'shell-2' && e.input).input.command, 'go test ./...');
  assert.equal(events.find(e => e.id === 'shell-2' && e.output).status, 'done');
});


for (const uid of [0, 1000]) {
test(`CLI turns retain testing tools, private credentials and execution hook for uid=${uid}`, async () => {
 let invocation;
 const testing={url:'https://app.example.test/project/',credentials:{password:'private-cli-secret'}};
 const cli=loadCli((bin,args,options)=>{
  invocation={args,options};const proc=new EventEmitter();proc.stdin=new PassThrough();proc.stdout=new PassThrough();proc.stderr=new PassThrough();
  setImmediate(()=>{proc.stdout.end(JSON.stringify({type:'result',result:'Finished',stop_reason:'end_turn'})+'\n');proc.stderr.end();proc.emit('close',0)});return proc;
 },{
  './registry':{getActiveQueue:()=>({testingContext:'FIXED OWNER ENVIRONMENT'})},
  '../providers/instance':{getContext:()=>({})},
  '../detect':{workspaceRoot:()=> 'workspace',resolveMcpBinary:()=> 'C:/tool folder/mfagent-mcp.exe',resolveCoreBinary:()=>({path:"C:/tool's folder/mfcore.exe"})},
  './testingEnvironment':{loadTestingEnvironment:async()=>testing,testingProcessEnvironment:()=>({MFAGENT_TEST_URL:testing.url,MFAGENT_CREDENTIAL_PASSWORD:testing.credentials.password}),testingPrompt:text=>text,redactTestingSecrets:text=>text},
 }, { getuid: () => uid, geteuid: () => uid });
 await cli.runClaudeCliTurn({appendLine(){}},'executor',{model:'configured',profile:{extra:{}}},'Test the app.',{});
 const args=invocation.args;
 const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]);assert.equal(mcp.mcpServers.mfagent.command,'C:/tool folder/mfagent-mcp.exe');
 if(uid===0) assert.ok(args[args.indexOf('--allowedTools')+1].split(',').includes('mcp__mfagent__*'));
 const settings=JSON.parse(args[args.indexOf('--settings')+1]);const hook=settings.hooks.PreToolUse[0].hooks[0];
 assert.match(hook.command,/testing-hook/);if(process.platform==='win32'){assert.equal(hook.shell,'powershell');assert.match(hook.command,/tool''s folder/)}
 assert.equal(invocation.options.env.MFAGENT_CREDENTIAL_PASSWORD,'private-cli-secret');
 assert.ok(!JSON.stringify(args).includes('private-cli-secret'));
});
}
