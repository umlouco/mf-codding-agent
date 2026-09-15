const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHost } = require('./headless-host.cjs');

test('planning sees real host capabilities before HTTP and CLI requests without project Playwright', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-planning-capabilities-'));
  const requests = [];
  const phases = [{ title: 'Improve registration', description: 'Add the requested registration behavior.', regionPaths: ['.'] }];
  const tasks = [
    { title: 'Validate registrations', description: 'Validate input and add passing tests.', kind: 'task', solutionVerifyPrompt: 'Reject invalid input.' },
    { title: 'Show registration status', description: 'Show status and add passing tests.', kind: 'task', solutionVerifyPrompt: 'Display the saved status.' },
  ];
  const replies = [phases, phases, tasks];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const content = JSON.stringify(replies.shift() ?? []);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = await createHost({ workspace: root, log() {},
    url: 'https://owner.example/wordpress/', credentials: { username: 'fixture-user', password: 'fixture-secret' },
    provider: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, plannerModel: 'fixture-model' },
  });
  const promptText = request => request.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  const checkContext = prompt => {
    assert.match(prompt, /HOST CAPABILITIES FOR PLANNING/);
    assert.match(prompt, /playwright_test\(cwd\?/);
    assert.match(prompt, /wordpress_skill\(.*skill\?/);
    assert.match(prompt, /runtime: .*bundled/i);
    assert.match(prompt, /Official Playwright CLI skill is bundled/);
    assert.match(prompt, /wp-plugin-development/);
    assert.match(prompt, /Do not add a Playwright installation/);
    assert.match(prompt, /previous planner's setup phase or task description is not an explicit owner request/);
    assert.doesNotMatch(prompt, /MANDATORY PLAYWRIGHT BOOTSTRAP|configured browser suite is not installed/);
    assert.doesNotMatch(prompt, /fixture-secret/);
  };
  try {
    const planning = host.load('src/queue/agentPlanning.ts');
    const regions = [{ path: '.', fileCount: 1, languages: { php: 1 } }];
    const goal = 'Improve registration in the WordPress plugin and verify the changed behavior.';
    const result = await planning.generatePhases(host.context, host.output, goal, regions, 150);
    assert.equal(result.length, 1);
    host.queue.insert(result[0], 1);
    const expansion = await planning.expandPhase(host.context, host.output, host.queue.list()[0], goal);
    assert.equal(expansion.tasks.length, 2, 'missing project npm package must not force a bootstrap or single-task repair');
    assert.equal(requests.length, 3, 'draft, final review and expansion each make one model request');
    for (const request of requests) checkContext(promptText(request));
    assert(!fs.existsSync(path.join(root, 'node_modules')), 'planning must not install or link packages into the application');
    assert(!fs.existsSync(path.join(root, 'package.json')), 'planning must not scaffold dependencies');

    await host.store.update({
      profiles: [...host.store.profiles, { id: 'test-cli', name: 'Fixture CLI', providerId: 'claude-cli' }],
      roles: { ...host.store.settings.roles, planner: { profileId: 'test-cli', model: 'fixture-model', effort: '' } },
    });
    const cli = host.load('src/queue/claudeCli.ts');
    const run = cli.runClaudeCliTurn;
    const cliRequests = [];
    cli.runClaudeCliTurn = async (_output, _role, _resolved, prompt) => {
      cliRequests.push(prompt);
      checkContext(prompt);
      return { text: '[]', stopReason: 'end_turn', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    };
    try {
      const runtime = host.load('src/queue/agentRuntime.ts');
      await runtime.runOnce(host.context, host.output, 'planner', goal, { planningOnly: true, skillTask: goal });
      await runtime.runOnce(host.context, host.output, 'supervisor', 'Review the draft plan.', { planningOnly: true, formatOnly: true });
      await runtime.runOnce(host.context, host.output, 'planner', 'Select scope.', { formatOnly: true });
      assert.equal(cliRequests.length, 3);
      assert.match(cliRequests[0], /# WP Plugin Development/, 'CLI draft retains selected official skill instructions');
      await assert.rejects(runtime.runOnce(host.context, host.output, 'planner', goal,
        { planningOnly: true, onCancellable: cancel => cancel() }), /Queue turn aborted/);
      assert.equal(cliRequests.length, 3, 'cancelling host preflight must prevent the CLI model request');
    } finally { cli.runClaudeCliTurn = run; }
    t.diagnostic('HTTP draft, final review, phase expansion, CLI planning/review and scope selection all received host facts before the model.');
  } finally {
    await host.close();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('missing host capabilities are reported accurately and enabled skills are retained', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-planning-missing-'));
  const host = await createHost({ workspace: root, log() {} });
  try {
    const { planningCapabilities } = host.load('src/queue/planningCapabilities.ts');
    const { bootstrapTddProblem } = host.load('src/queue/failureDecomposition.ts');
    assert.equal(bootstrapTddProblem('Run tests before npm install using the bundled Playwright runtime.'), undefined);
    assert.match(bootstrapTddProblem('Run npx playwright test using only Node fs/path and no imports from @playwright/test.'), /registered|test\(/);
    await host.store.update({
      skills: [{ id: 'enabled', name: 'Owner workflow', content: 'Keep browser specs in the owner-selected external directory.' },
        { id: 'disabled', name: 'Disabled fixture', content: 'DO_NOT_INCLUDE_DISABLED_SKILL' }],
      skillGroups: [{ id: 'enabled-group', name: 'Enabled', skillIds: ['enabled'] }],
    });
    host.queue.setSkillGroupEnabled(['enabled-group'], true);
    const client = { request: async (method, params) => {
      if (method === 'tools/list') return [{ name: 'playwright_status', description: 'Inspect runtime' }];
      assert.equal(params.name, 'playwright_status');
      return { output: 'Not ready: no Playwright runtime is available', isError: false };
    } };
    const prompt = await planningCapabilities(client, true);
    assert.match(prompt, /Not ready: no Playwright runtime is available/);
    assert.match(prompt, /wordpress_skill: unavailable \(not registered/);
    assert.match(prompt, /Keep browser specs in the owner-selected external directory/);
    assert.doesNotMatch(prompt, /DO_NOT_INCLUDE_DISABLED_SKILL/);
    await assert.rejects(planningCapabilities({ request: async () => [] }, false), /Cannot plan without/);
  } finally {
    await host.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
