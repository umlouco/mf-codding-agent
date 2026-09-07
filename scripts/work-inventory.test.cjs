const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assert, loader, keep, usage } = require('./queue-scope-helpers.cjs');
const load = loader();
const { indexRepository, matchesPath, resolveWorkInventory, discoverWork } = load('src/queue/workInventory.ts');
const { inventoryScopePlan, scopeBoundary, boundedTask } = load('src/queue/scopeBoundary.ts');
const { parseScopeAssessment, replacementTasks, scopeBlocked } = load('src/queue/scopePlan.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const contract = { id: 1, seq: 1, createdAt: 1, title: 'Correct the first adapter',
  description: 'Apply the requested compatibility behavior throughout the supported adapter population.',
  implVerifyPrompt: 'Inspect every supported adapter and retain the owner-supplied compatibility guarantees.',
  solutionVerifyPrompt: 'Prove every adapter using the supplied runtime and original end-to-end cases.',
  solutionVerifyCommand: 'node scripts/acceptance.cjs --preserve-contract',
  output: 'The first adapter and common setup already work; retain them.', validationReport: 'The first local check passed.',
  region: '', maxAttempts: 3 };
const files = ['adapters/a/main.go', 'adapters/a/main_test.go', 'adapters/b/index.py',
  'adapters/c/nested/handler.ts', 'adapters/c/nested/handler.test.ts', 'shared/runtime.ts', 'docs/guide.md'];
const repository = { files, complete: true, problems: [], fingerprint: 'fixture-index' };
const collection = (include = ['adapters/**'], extra = {}) => ({
  key: 'adapters', include, exclude: [], unit: 'file', reason: 'All independently requested adapter targets.', ...extra,
});
const enumeration = (collections = [collection()]) => ({
  strategy: 'enumerate', reason: 'The adapters are independent outcomes under the original contract.', collections,
});

function workspace(t, entries = files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-work-inventory-'));
  const closers = [];
  const write = (name, contents = `fixture ${name}`) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  };
  entries.forEach(name => write(name));
  t.after(() => {
    closers.reverse().forEach(close => close());
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('mf-work-inventory-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, write, closeWith: close => closers.push(close) };
}

function supervisorFixture(t, answer, patch = {}) {
  const tree = workspace(t);
  const calls = [];
  const splits = [];
  const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: tree.root } }],
    getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
  const modules = loader({ vscode, './agents': {
    extractJson: text => JSON.parse(text),
    runOnce: async (...args) => {
      calls.push(args);
      return { text: JSON.stringify(await answer(args[3], calls.length, args[4])), usage };
    },
  } });
  const { TaskQueue } = modules('src/queue/db.ts');
  const queue = TaskQueue.open(path.join(tree.root, '.mfagent', 'queue.sqlite'));
  tree.closeWith(() => queue.close());
  queue.replaceAll([{ ...contract, ...patch }]);
  const task = queue.list()[0];
  queue.update(task.id, { output: contract.output, validationReport: contract.validationReport });
  queue.setMeta('goal', 'Deliver the existing owner contract without repeated broad execution.');
  queue.setInstructions('Use the owner-supplied runtime; never narrow acceptance requirements.');
  queue.setRunState('RUNNING');
  const { ScopeSupervisor } = modules('src/queue/scopeSupervisor.ts');
  const host = { context: {}, output: { appendLine() {} }, queue, task: queue.get(task.id), role: 'executor',
    current: () => true, intervalMs: 30_000, preflightActivity() {},
    split: (assessment, snapshot) => { splits.push({ assessment, snapshot }); return true; } };
  const create = () => {
    const scope = new ScopeSupervisor(host);
    tree.closeWith(() => scope.close());
    return scope;
  };
  return { ...tree, queue, task: queue.get(task.id), calls, splits, host, create };
}

test('repository indexing is recursive, stable, language-neutral and excludes generated work', t => {
  const tree = workspace(t, [...files, 'node_modules/pkg/index.js', 'dist/output.js', '.mfagent/history.json']);
  const index = indexRepository(tree.root);
  assert.equal(index.complete, true);
  assert.deepEqual(plain(index.files), [...files].sort());
  assert.equal(index.fingerprint, indexRepository(tree.root).fingerprint);
  tree.write('adapters/d/main.rs');
  assert.notEqual(index.fingerprint, indexRepository(tree.root).fingerprint);
  assert.ok(indexRepository(tree.root).files.includes('adapters/d/main.rs'));
});

test('git indexing includes tracked and new source, but not ignored output or tracked deletions', t => {
  const tree = workspace(t, ['tracked.txt', 'deleted.txt']);
  const git = args => execFileSync('git', ['-C', tree.root, ...args], { windowsHide: true, stdio: 'pipe' });
  git(['init']);
  tree.write('.gitignore', 'ignored/\n');
  git(['add', 'tracked.txt', 'deleted.txt', '.gitignore']);
  fs.unlinkSync(path.join(tree.root, 'deleted.txt'));
  tree.write('new/source.ex');
  tree.write('ignored/output.txt');
  assert.deepEqual(plain(indexRepository(tree.root).files), ['.gitignore', 'new/source.ex', 'tracked.txt']);
});

test('selectors enumerate the entire recursive population rather than a model-provided sample', () => {
  const raw = { ...enumeration(), units: [{ key: 'sample', targets: ['adapters/a/main.go'] }] };
  const inventory = resolveWorkInventory(raw, repository);
  assert.deepEqual(plain(inventory.units.flatMap(unit => unit.targets)), files.filter(file => file.startsWith('adapters/')));
  assert.equal(inventory.units.length, 5);
  assert.equal(new Set(inventory.units.map(unit => unit.key)).size, 5);
  assert.deepEqual(plain(inventory.units), plain(resolveWorkInventory(raw, repository).units));
  assert.equal(matchesPath('adapters/main.go', 'adapters/**/*.go'), true);
  assert.equal(matchesPath('adapters/a/main.go', 'adapters/**/*.go'), true);
  assert.equal(matchesPath('adapters/a/main.go', 'adapters/*.go'), false);
  assert.equal(matchesPath('adapters/a/main.go', 'adapters/?/main.go'), true);
});

test('directory units retain complete containing modules, including supporting files', () => {
  const inventory = resolveWorkInventory(enumeration([collection(['adapters/**'], { unit: 'directory' })]), repository);
  assert.deepEqual(plain(inventory.units.map(unit => [unit.label, unit.targets])), [
    ['adapters/a', ['adapters/a/main.go', 'adapters/a/main_test.go']],
    ['adapters/b', ['adapters/b/index.py']],
    ['adapters/c/nested', ['adapters/c/nested/handler.ts', 'adapters/c/nested/handler.test.ts']],
  ]);
});

test('disjoint collections can cover multiple populations and explicit exclusions', () => {
  const inventory = resolveWorkInventory(enumeration([
    collection(['adapters/**'], { exclude: ['**/*test*'] }),
    collection(['shared/**'], { key: 'runtime', reason: 'Requested shared supporting outcome.' }),
  ]), repository);
  assert.deepEqual(plain(inventory.units.flatMap(unit => unit.targets)), [
    'adapters/a/main.go', 'adapters/b/index.py', 'adapters/c/nested/handler.ts', 'shared/runtime.ts',
  ]);
});

test('overlapping populations, nonexistent targets and incomplete indexes cannot authorize enumeration', () => {
  assert.throws(() => resolveWorkInventory(enumeration([
    collection(), collection(['adapters/**/*.go'], { key: 'overlap' }),
  ]), repository), /Overlapping/);
  assert.throws(() => resolveWorkInventory(enumeration([collection(['missing/**'])]), repository), /no current/);
  assert.throws(() => resolveWorkInventory(enumeration(), { ...repository, complete: false }), /incomplete/);
  assert.throws(() => resolveWorkInventory(enumeration([collection(['shared/**'])]), repository), /at least two/);
  assert.throws(() => resolveWorkInventory(enumeration([collection(), collection(['shared/**'])]), repository), /Duplicate/);
});

test('all selectors must be validated even if an earlier selector matches every file', () => {
  for (const pattern of ['../escape/**', '/absolute/**', 'bad\\path', 'adapters/{a,b}/**', 'adapters/[ab]/**', '']) {
    assert.throws(() => matchesPath('adapters/a/main.go', pattern), /Invalid/);
    assert.throws(() => resolveWorkInventory(enumeration([collection(['**', pattern])]), repository), /Invalid/);
  }
});

test('malformed discovery repairs once with original evidence, then rejects without improvising work', async () => {
  const prompts = [];
  const inventory = await discoverWork(contract, 'Owner objective', 'Owner notes', repository, async prompt => {
    prompts.push(prompt);
    return JSON.stringify(prompts.length === 1 ? enumeration([collection(['missing/**'])]) : enumeration());
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Previous response/);
  for (const value of [contract.description, contract.implVerifyPrompt, contract.solutionVerifyPrompt, files[3], 'Owner notes']) {
    assert.ok(prompts[1].includes(value));
  }
  assert.equal(inventory.units.length, 5);
  let failures = 0;
  await assert.rejects(() => discoverWork(contract, '', '', repository, async () => {
    failures++; return '{malformed';
  }));
  assert.equal(failures, 2);
});

test('discovery uses the model decision, not framework, title or task-text keyword heuristics', async () => {
  const task = { ...contract, title: 'One wording', description: 'Resolve the stated behavior.',
    implVerifyPrompt: 'Inspect the requested implementation.', solutionVerifyPrompt: 'Prove it.' };
  const atomic = await discoverWork(task, '', '', repository, async () => JSON.stringify({
    strategy: 'atomic', reason: 'One indivisible shared behavior plus callers and tests.',
  }));
  const enumerated = await discoverWork(task, '', '', repository, async () => JSON.stringify(enumeration()));
  assert.equal(atomic.strategy, 'atomic');
  assert.equal(enumerated.units.length, 5);
  assert.equal(parseScopeAssessment(keep('cohesive'), task, atomic).action, 'KEEP');
  assert.throws(() => parseScopeAssessment(keep('cohesive'), task, enumerated), /requires execution tickets/);
});

test('blocked discovery cannot be silently reclassified as atomic or KEEP', async () => {
  const blocked = await discoverWork(contract, '', '', repository, async () => JSON.stringify({
    strategy: 'blocked', reason: 'The owner has not supplied the external acceptance fixture.',
  }));
  assert.equal(blocked.strategy, 'blocked');
  assert.throws(() => inventoryScopePlan(contract, blocked), /enumerated/);
  assert.throws(() => parseScopeAssessment(keep('cohesive'), contract, blocked), /blocked|evidence/i);
});

test('inventory becomes one ticket per unit with prerequisites and unchanged final acceptance last', () => {
  const inventory = resolveWorkInventory(enumeration([collection(['adapters/**'], { unit: 'directory' })]), repository);
  const plan = parseScopeAssessment(inventoryScopePlan(contract, inventory), contract, inventory);
  assert.equal(plan.parts.length, inventory.units.length + 2);
  assert.equal(plan.parts[0].key, 'prerequisites');
  const final = plan.parts.at(-1);
  assert.equal(final.key, 'integration');
  for (const field of ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand']) {
    assert.equal(final[field], contract[field]);
  }
  assert.deepEqual(plain(final.dependsOn), plain(plan.parts.slice(0, -1).map(part => part.key)));
  for (const unit of inventory.units) {
    const owners = plan.parts.filter(part => part.workUnit === unit.key);
    assert.equal(owners.length, 1);
    assert.deepEqual(plain(owners[0].targets), plain(unit.targets));
    assert.deepEqual(plain(owners[0].dependsOn), ['prerequisites']);
    assert.ok(owners[0].handoff.includes(contract.output));
  }
});

test('ticket validation rejects omitted units, omitted targets, duplicate ownership and invented work', () => {
  const inventory = resolveWorkInventory(enumeration(), repository);
  const corruptions = [
    plan => { plan.parts.splice(1, 1); },
    plan => { plan.parts[1].targets = []; },
    plan => { plan.parts.push({ ...plan.parts[1], key: 'duplicate' }); },
    plan => { plan.parts[1].targets.push('invented/missing.ts'); },
    plan => { plan.parts.push({ ...plan.parts[1], key: 'invented', workUnit: 'invented-unit', targets: ['invented/missing.ts'] }); },
    plan => { plan.parts.push({ ...plan.parts[1], key: 'hidden-duplicate', workUnit: 'another-unit' }); },
    plan => { plan.parts.at(-1).targets = [...plan.parts[1].targets]; },
    plan => { plan.parts.at(-1).solutionVerifyCommand = 'echo PASS'; },
    plan => { plan.parts.at(-1).solutionVerifyPrompt = 'Ignore the original runtime requirements.'; },
    plan => { plan.parts.at(-1).implVerifyPrompt = 'Inspect only the easiest adapter.'; },
    plan => { plan.parts.at(-1).description = 'Do only one adapter and call the whole project complete.'; },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const proposal = plain(inventoryScopePlan(contract, inventory));
    corrupt(proposal);
    assert.throws(() => parseScopeAssessment(proposal, contract, inventory), `Corruption ${index} must be rejected`);
  }
});

test('persisted child boundaries retain original criteria and prevent expansion into sibling tickets', () => {
  const inventory = resolveWorkInventory(enumeration(), repository);
  const plan = parseScopeAssessment(inventoryScopePlan(contract, inventory), contract, inventory);
  const tickets = replacementTasks(plan, contract, 'scopeSplit:original');
  const rows = tickets.map((ticket, index) => ({ ...contract, ...ticket, id: index + 10, seq: index + 1, status: 'PENDING' }));
  const child = rows[1];
  const persisted = JSON.parse(child.region).scopeSplit;
  assert.deepEqual(persisted.targets, plain(inventory.units[0].targets));
  assert.equal(persisted.workUnit, inventory.units[0].key);
  assert.ok(scopeBoundary(child).includes(persisted.workUnit));
  assert.ok(child.description.includes(contract.description));
  assert.match(child.description, /Do not revert/);
  assert.match(boundedTask(child).description, /PERSISTED EXECUTION TICKET/);
  assert.equal(child.description.includes('PERSISTED EXECUTION TICKET'), false, 'boundary projection must not mutate persisted text');
  assert.equal(scopeBlocked(child, rows), true);
  rows[0].status = 'VERIFIED';
  assert.equal(scopeBlocked(child, rows), false);
  assert.equal(scopeBlocked(rows.at(-1), rows), true);
  assert.equal(scopeBoundary({ ...contract, region: '{invalid' }), '');
  assert.equal(boundedTask(contract), contract);
});

test('actual scope preflight discovers source population before admitting work and creates complete tickets without another model turn', async t => {
  const f = supervisorFixture(t, async prompt => {
    assert.match(prompt, /discovery stage/);
    for (const value of [contract.description, contract.implVerifyPrompt, contract.solutionVerifyPrompt, ...files]) {
      assert.ok(prompt.includes(value));
    }
    return enumeration([collection(['adapters/**'], { unit: 'directory' })]);
  });
  assert.equal(await f.create().preflight(), false, 'parent must not launch an executor');
  assert.equal(f.calls.length, 1, 'model names population once; the host expands its full membership');
  assert.equal(f.splits.length, 1);
  const plan = f.splits[0].assessment;
  assert.equal(plan.parts.filter(part => part.workUnit).length, 3);
  assert.equal(plan.parts.at(-1).solutionVerifyCommand, contract.solutionVerifyCommand);
  assert.equal(f.queue.countEvents(f.task.id, 'work-inventory'), 1);
  assert.equal(f.queue.get(f.task.id).output, contract.output);
});

test('atomic discovery retains a cohesive multi-file task and caches membership until it changes', async t => {
  let discoveries = 0;
  const f = supervisorFixture(t, async prompt => {
    if (prompt.includes('discovery stage')) {
      discoveries++;
      return { strategy: 'atomic', reason: 'One shared interface change needs all coupled callers and tests.' };
    }
    return keep('cohesive');
  });
  assert.equal(await f.create().preflight(), true);
  assert.equal(f.splits.length, 0);
  assert.equal(await f.create().preflight(), true);
  assert.equal(discoveries, 1);
  f.write('adapters/d/new.ex');
  assert.equal(await f.create().preflight(), true);
  assert.equal(discoveries, 2);
  assert.equal(f.queue.get(f.task.id).description, contract.description);
});

test('blocked or repeatedly malformed actual discovery cannot launch or split a task', async t => {
  for (const malformed of [false, true]) {
    const f = supervisorFixture(t, async () => malformed ? { strategy: 'enumerate', reason: 'Missing collections.' }
      : { strategy: 'blocked', reason: 'Missing external acceptance fixture.' });
    await assert.rejects(() => f.create().preflight(), malformed ? /collection/i : /Discovery needs evidence/);
    assert.equal(f.splits.length, 0);
    assert.equal(f.calls.length, malformed ? 2 : 1);
    assert.equal(f.queue.get(f.task.id).description, contract.description);
  }
});

test('a changed contract or repository population during discovery invalidates the result', async t => {
  for (const change of ['contract', 'population']) {
    let f;
    f = supervisorFixture(t, async () => {
      if (change === 'contract') f.queue.update(f.task.id, { solutionVerifyPrompt: 'New owner requirement.' });
      else f.write('adapters/d/new.ex');
      return enumeration();
    });
    await assert.rejects(() => f.create().preflight(), /changed during discovery/);
    assert.equal(f.splits.length, 0);
  }
});

test('admitted child starts without another static planning call or rediscovering the parent request', async t => {
  const inventory = resolveWorkInventory(enumeration(), repository);
  const child = replacementTasks(parseScopeAssessment(inventoryScopePlan(contract, inventory), contract, inventory),
    contract, 'parent-archive')[1];
  const f = supervisorFixture(t, async () => assert.fail('The saved partition already admitted this child'), child);
  f.queue.setMeta('parent-archive', JSON.stringify({ task: { ...contract, id: 999 },
    assessment: parseScopeAssessment(inventoryScopePlan(contract, inventory), contract, inventory) }));
  assert.equal(await f.create().preflight(), true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.splits.length, 0);
});
