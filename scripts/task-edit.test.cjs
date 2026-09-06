// Run with: node --test scripts/task-edit.test.cjs
// Exercise the planner-to-extension proposal contract without starting a model or VS Code.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');

const source = readFileSync(path.join(__dirname, '..', 'src/queue/agents.ts'), 'utf8');
const { outputText } = ts.transpileModule(source +
  '\nexport function setTestRunner(runner: typeof runOnce) { runOnce = runner; }', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const agents = {};
vm.runInNewContext(outputText, { exports: agents, Buffer, require: () => ({}) });

const usage = { input: 15, output: 20, cacheRead: 0, cacheWrite: 0 };
const tasks = Array.from({ length: 251 }, (_, index) => ({
  id: 1000 + index, seq: index + 1, status: 'PENDING',
  title: `SCORM package patch ${index + 1}`, description: `Patch package ${index + 1}.`,
}));
const noChange = { summary: 'The queue already matches the request.', edits: [], deletes: [], adds: [] };
const parse = proposal => agents.parseTaskEditResult(JSON.stringify(proposal), tasks, usage);
const plain = value => JSON.parse(JSON.stringify(value));

test('task editor returns all 251 deletions and the single replacement task', async () => {
  let requestedPrompt = '';
  const proposal = {
    summary: 'Replace the 251 package-patching tasks with one editor development task.',
    edits: [], deletes: tasks.map(task => task.seq),
    adds: [{ title: 'Build the SCORM editor', description: 'Develop the editor requested by the user.' }],
  };
  agents.setTestRunner(async (_, __, role, prompt) => {
    assert.equal(role, 'planner');
    requestedPrompt = prompt;
    return { text: JSON.stringify(proposal), usage, stopReason: 'end_turn' };
  });
  const result = await agents.editTasks({}, {}, tasks, 'Replace all package patching with editor development.');
  assert.equal(result.deletes.length, 251);
  assert.deepEqual(plain(result.deletes), proposal.deletes);
  assert.deepEqual(plain(result.adds), proposal.adds);
  assert.equal(result.usage, usage);
  assert.match(requestedPrompt, /#251 \[PENDING\]/);
  assert.match(requestedPrompt, /Your reply does not\s+itself change the queue/);
  assert.match(requestedPrompt, /Preserve VERIFIED tasks/);
});

test('complete revisions do not truncate edits, additions, or task titles', () => {
  const title = 'A complete task title '.repeat(15);
  const proposal = {
    ...noChange,
    edits: tasks.map(task => ({ seq: task.seq, description: `Updated description ${task.seq}` })),
    adds: tasks.map(task => ({ title: `${title}${task.seq}`, description: `New task ${task.seq}` })),
  };
  const result = parse(proposal);
  assert.equal(result.edits.length, 251);
  assert.equal(result.adds.length, 251);
  assert.equal(result.edits[250].description, 'Updated description 251');
  assert.equal(result.adds[250].title, `${title}251`);
});

test('a malformed reference after the old 40-item boundary rejects the complete proposal', () => {
  const deletes = tasks.map(task => task.seq);
  deletes[250] = 999;
  assert.throws(() => parse({ ...noChange, deletes }), /deletes\[250\].*unknown task #999/);
  const edits = tasks.map(task => ({ seq: task.seq, description: 'Updated' }));
  edits[250] = null;
  assert.throws(() => parse({ ...noChange, edits }), /edits\[250\] must be an object/);
});

test('a summary alone cannot masquerade as applied edits', () => {
  assert.throws(() => parse({ summary: 'Removed all 251 SCORM package-patching tasks.' }),
    /edits must be an array/);
});

test('an explicit no-op remains a valid proposal', () => {
  assert.deepEqual(plain(parse(noChange)), { ...noChange, usage });
});

test('one complete plain or fenced task-edit envelope is accepted', () => {
  const json = JSON.stringify(noChange);
  for (const response of [json, ` \n${json}\n `, `\`\`\`json\n${json}\n\`\`\``, `\`\`\`\n${json}\n\`\`\``]) {
    assert.deepEqual(plain(agents.parseTaskEditResult(response, tasks, usage)), { ...noChange, usage });
  }
});

test('a valid preliminary proposal followed by a truncated revision is never accepted', async () => {
  const draft = JSON.stringify({ ...noChange, summary: 'Preliminary subset only.', deletes: [1] });
  const truncated = draft + '\nFinal replacement follows:\n' +
    '{"summary":"Replace both", "edits":[], "deletes":[1,2], "adds":[{"title":"Replacement';
  assert.throws(() => agents.parseTaskEditResult(truncated, tasks, usage), /one complete JSON object/);
  agents.setTestRunner(async () => ({ text: truncated, stopReason: 'max_iterations', usage }));
  await assert.rejects(() => agents.editTasks({}, {}, tasks, 'Replace both tasks with one task.'),
    /planning did not complete/);
});

test('multiple complete proposals and prose around a proposal are rejected without fragment extraction', () => {
  const first = JSON.stringify({ ...noChange, deletes: [1] });
  const second = JSON.stringify({ ...noChange, deletes: [1, 2] });
  for (const response of [
    `${first}\n${second}`,
    `\`\`\`json\n${first}\n\`\`\`\n\`\`\`json\n${second}\n\`\`\``,
    `First draft: ${first}`,
    `${first}\nI will revise this after further inspection.`,
    '{"summary":"No change", "edits":[], "deletes":[], "adds":[],}',
  ]) {
    assert.throws(() => agents.parseTaskEditResult(response, tasks, usage), /one complete JSON object/);
  }
});

test('incomplete planner outcomes reject even a syntactically complete proposal', async () => {
  for (const stopReason of ['max_iterations', 'context_limit', 'repeated_tool_error', 'cancelled',
    'error', 'length', 'max_tokens', 'token_limit', 'incomplete', 'tool_use']) {
    agents.setTestRunner(async () => ({ text: JSON.stringify({ ...noChange, deletes: [1] }), stopReason, usage }));
    await assert.rejects(() => agents.editTasks({}, {}, tasks, 'Remove task one.'),
      /planning did not complete/, stopReason);
  }
});

test('normal provider completion outcomes and the legacy empty reason remain accepted', async () => {
  for (const stopReason of ['', 'end_turn', 'stop', 'stop_sequence', 'completed']) {
    agents.setTestRunner(async () => ({ text: JSON.stringify(noChange), stopReason, usage }));
    const result = await agents.editTasks({}, {}, tasks, 'Keep the current queue.');
    assert.equal(result.deletes.length, 0);
    assert.equal(result.summary, noChange.summary);
  }
});

test('repeated target references are deduplicated and compatible edit fields are combined', () => {
  const result = parse({ ...noChange, deletes: [1, 1, 3, 3], edits: [
    { seq: 2, title: 'Renamed' }, { seq: 2, title: 'Renamed' },
    { seq: 2, description: 'The complete replacement instructions.', solutionVerifyCommand: '' },
  ] });
  assert.deepEqual(plain(result.deletes), [1, 3]);
  assert.deepEqual(plain(result.edits), [{ seq: 2, title: 'Renamed',
    description: 'The complete replacement instructions.', solutionVerifyCommand: '' }]);
});

test('conflicting actions are rejected instead of choosing an arbitrary partial result', () => {
  assert.throws(() => parse({ ...noChange,
    edits: [{ seq: 1, title: 'One' }, { seq: 1, title: 'Two' }] }), /conflicting edits to title/);
  assert.throws(() => parse({ ...noChange, edits: [{ seq: 1, title: 'One' }], deletes: [1] }),
    /cannot be both edited and deleted/);
});

for (const [label, proposal, expected] of [
  ['missing array', { summary: 'Change', edits: [], adds: [] }, /deletes must be an array/],
  ['non-array field', { ...noChange, deletes: {} }, /deletes must be an array/],
  ['non-text summary', { ...noChange, summary: 251 }, /summary must be a string/],
  ['blank summary', { ...noChange, summary: '  ' }, /summary must explain/],
  ['string sequence', { ...noChange, deletes: ['1'] }, /positive integer sequence/],
  ['fractional sequence', { ...noChange, deletes: [1.5] }, /positive integer sequence/],
  ['negative sequence', { ...noChange, deletes: [-1] }, /positive integer sequence/],
  ['unknown edit target', { ...noChange, edits: [{ seq: 252, title: 'Missing' }] }, /unknown task #252/],
  ['empty edit', { ...noChange, edits: [{ seq: 1 }] }, /at least one field to change/],
  ['non-text edit', { ...noChange, edits: [{ seq: 1, description: false }] }, /description must be a string/],
  ['null edit field', { ...noChange, edits: [{ seq: 1, title: null }] }, /title must be a string/],
  ['missing addition description', { ...noChange, adds: [{ title: 'New' }] }, /description must be a string/],
  ['blank addition title', { ...noChange, adds: [{ title: ' ', description: 'Work' }] }, /title must not be empty/],
  ['unsupported edit permission', { ...noChange, edits: [{ seq: 1, status: 'VERIFIED' }] }, /unsupported field "status"/],
  ['unsupported addition field', { ...noChange, adds: [{ title: 'New', description: 'Work', kind: 'phase' }] }, /unsupported field "kind"/],
  ['unsupported reply field', { ...noChange, deleteAll: true }, /unsupported field "deleteAll"/],
]) {
  test(`malformed task edit proposal is rejected: ${label}`, () => {
    assert.throws(() => parse(proposal), expected);
  });
}

test('the parser retains VERIFIED references for the application layer to enforce protection', () => {
  const protectedTasks = [{ ...tasks[0], status: 'VERIFIED' }];
  const result = agents.parseTaskEditResult(JSON.stringify({ ...noChange, deletes: [1] }), protectedTasks, usage);
  assert.deepEqual(plain(result.deletes), [1]);
});
