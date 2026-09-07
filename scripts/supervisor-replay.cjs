#!/usr/bin/env node
// Replay actual scope supervision on a backup. NEVER open the original through TaskQueue.
// node scripts/supervisor-replay.cjs --workspace <repo> --seq <number> [--report <outside-repo.json>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { loader } = require('./queue-scope-helpers.cjs');
const { agents } = require('./queue-progress-helpers.cjs');
const { resolveSupervisor, corePath, runCore, sanitized } = require('./supervisor-replay-core.cjs');

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex');
const contractFields = ['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand'];
const contract = task => Object.fromEntries(contractFields.map(key => [key, task[key]]));
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') return { help: true };
    if (!['--workspace', '--seq', '--report'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw Error('Usage: supervisor-replay.cjs --workspace <repo> --seq <number> [--report <outside-repo.json>]');
    }
    if (options[key.slice(2)] !== undefined) throw Error(`Duplicate argument ${key}.`);
    options[key.slice(2)] = argv[++i];
  }
  if (!options.workspace || !/^\d+$/.test(options.seq || '') || Number(options.seq) < 1) {
    throw Error('Specify --workspace and a positive integer --seq.');
  }
  options.workspace = fs.realpathSync(options.workspace);
  options.seq = Number(options.seq);
  if (options.report) {
    const parent = fs.realpathSync(path.dirname(path.resolve(options.report)));
    options.report = path.join(parent, path.basename(options.report));
    if (inside(options.workspace, options.report) || fs.existsSync(options.report)) {
      throw Error('The report must be a NEW file outside the original workspace.');
    }
  }
  return options;
}

function sourceReceipt(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    return { taskCount: tasks.length, taskListHash: hash(tasks),
      databaseFiles: Object.fromEntries(['', '-wal'].map(suffix => [path.basename(file + suffix),
        fs.existsSync(file + suffix) ? hash(fs.readFileSync(file + suffix)) : null])) };
  } finally { db.close(); }
}

async function replay(options) {
  const config = resolveSupervisor();
  const originalFile = path.join(options.workspace, '.mfagent', 'queue.db');
  if (!fs.existsSync(originalFile)) throw Error('No existing .mfagent/queue.db found in the selected workspace.');
  if (typeof backup !== 'function') throw Error('This replay requires a Node version with node:sqlite backup support.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-supervisor-replay-'));
  if (inside(options.workspace, fs.realpathSync(scratch))) throw Error('The temporary directory cannot be inside the original workspace.');
  const reportFile = options.report || path.join(scratch, 'report.json');
  const before = sourceReceipt(originalFile);
  const scratchFile = path.join(scratch, 'queue.db');
  const source = new DatabaseSync(originalFile, { readOnly: true });
  try { await backup(source, scratchFile); } finally { source.close(); }

  const started = Date.now();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const calls = [];
  let selected, inventory, applied = false, scope, failure;
  const settings = { workspace: {
    workspaceFolders: [{ uri: { fsPath: options.workspace } }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  } };
  const extractJson = agents().extractJson;
  const load = loader({ vscode: settings,
    './command': { runVerificationCommand: () => { throw Error('Command execution is prohibited in supervisor replay.'); } },
    './agents': { extractJson,
    runOnce: async (_context, _output, role, prompt, opts) => {
      if (role !== 'supervisor') throw Error('Replay may invoke only the supervisor role.');
      const call = { number: calls.length + 1, promptHash: hash(prompt), elapsedMs: 0, completed: false };
      calls.push(call);
      process.stderr.write(`Supervisor replay: model request ${call.number} started.\n`);
      const at = Date.now();
      try {
        const result = await runCore(config, scratch, prompt, opts);
        call.completed = true;
        call.responseHash = hash(result.text);
        for (const key of Object.keys(totals)) totals[key] += Number(result.usage?.[key] || 0);
        return { ...result, usage: result.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      } finally { call.elapsedMs = Date.now() - at; }
    },
  } });
  const { TaskQueue } = load('src/queue/db.ts');
  const { Orchestrator } = load('src/queue/orchestrator.ts');
  const queue = TaskQueue.open(scratchFile);
  const initialRows = queue.list();
  const task = initialRows.find(row => row.seq === options.seq);
  if (!task) { queue.close(); throw Error(`The original task list has no task at sequence ${options.seq}.`); }
  const originalContract = contract(task);
  const runner = Object.create(Orchestrator.prototype);
  Object.assign(runner, { queue, context: {}, output: { appendLine() {} }, changed() {},
    wakeAfterHandoff() {}, reviewed: new Map(), executionGen: 0, reviewGen: 0, cycle: 0,
    disposed: false, supervising: false, review: null, executionAbort: null });
  const actualSplit = runner.applyScopeSplit.bind(runner);
  runner.applyScopeSplit = (assessment, snapshot, current) => {
    selected = assessment;
    const event = queue.events(task.id, -1).find(row => row.kind === 'work-inventory');
    if (event) { try { inventory = JSON.parse(event.message); } catch {} }
    if (hash(contract(snapshot)) !== hash(originalContract)) throw Error('The replay task contract was altered before scheduling.');
    applied = actualSplit(assessment, snapshot, current);
    return applied;
  };
  let finalRows = [];
  try {
    queue.setRunState('RUNNING'); // Runtime metadata only, in the isolated backup.
    scope = runner.scopeWatch(task, 'executor', () => !!queue.get(task.id) && !runner.disposed,
      (phase, detail) => queue.recordActivity(task.id, phase, detail, 'supervisor'));
    await scope.preflight();
  } catch (error) { failure = sanitized(error, config.apiKey); }
  finally {
    scope?.close();
    const event = queue.events(null, -1).find(row => row.kind === 'work-inventory' && row.taskId === task.id);
    if (event) { try { inventory = JSON.parse(event.message); } catch {} }
    finalRows = queue.list();
    queue.close();
  }
  const replacements = applied ? finalRows.filter(row => !initialRows.some(old => old.id === row.id)) : [];
  const finalGate = replacements.find(row => {
    try { return JSON.parse(row.region).scopeSplit?.integration; } catch { return false; }
  });
  const integration = selected?.parts?.find(part => part.integration);
  // Persistence adds explicit parent/handoff annotations to descriptions. Check
  // the complete original contract plus the unchanged executable check fields.
  const preserved = finalGate ? !!integration && hash(contract(integration)) === hash(originalContract) &&
    finalGate.description.startsWith(originalContract.description + '\n\n') &&
    contractFields.slice(1).every(key => finalGate[key] === originalContract[key])
    : !applied && hash(contract(finalRows.find(row => row.id === task.id) || task)) === hash(originalContract);
  const after = sourceReceipt(originalFile);
  const unchanged = before.taskListHash === after.taskListHash;
  const report = {
    schema: 1, mode: 'actual ScopeSupervisor preflight + actual applyScopeSplit on SQLite backup',
    workspace: options.workspace, sequence: options.seq, sourceTaskId: task.id,
    sourceTaskTitle: task.title, originalContractHash: hash(originalContract),
    transport: { source: config.source, provider: config.kind, model: config.model,
      coreHash: hash(fs.readFileSync(corePath())), responseOnly: true, inspectOnly: true,
      workspaceRoot: scratch, memoryEnabled: false, toolsExecuted: 0 },
    limitations: ['Evidence-fed inference only: no model file inspection, tools, browser, execution or validation.',
      'Repository membership is observed from the original workspace; core cognition and queue writes are isolated in scratch.',
      'This tests discovery and scheduling, not whether implementation or application behavior is correct.',
      'Stored VS Code secrets are not extracted; authenticated endpoints require an environment API key.',
      'SQLite read-only readers may participate in shared-memory locking; no original database is opened for writing.'],
    outcome: failure ? 'error' : applied ? 'split' : inventory?.strategy || 'keep',
    ...(failure ? { error: failure } : {}),
    selected: { strategy: inventory?.strategy || (selected ? 'scope-plan' : null),
      reason: inventory?.reason || selected?.reason || null,
      collections: inventory?.collections || [], units: inventory?.units || [],
      replacementTitles: replacements.map(row => ({ seq: row.seq, title: row.title })) },
    tasks: { before: initialRows.length, after: finalRows.length, replacementCount: replacements.length,
      discoveredUnits: inventory?.units?.length || 0,
      originalContractUnmodifiedBeforeDecision: true,
      finalContractPreserved: preserved,
      descriptionAnnotations: applied ? 'The persisted description appends parent/handoff context; original requirements and checks are retained.' : null },
    source: { originalTasksUnchanged: unchanged,
      originalDatabaseFilesUnchanged: hash(before.databaseFiles) === hash(after.databaseFiles), before, after },
    cost: { requests: calls.length, tokens: totals, elapsedMs: Date.now() - started,
      monetary: null, note: 'No authoritative configured price is available; token usage is reported without inventing a cost.' },
    calls, artifacts: { scratch, queue: scratchFile, report: reportFile },
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (failure || !unchanged || !report.tasks.finalContractPreserved) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  Promise.resolve().then(() => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: supervisor-replay.cjs --workspace <repo> --seq <number> [--report <new-file-outside-repo.json>]\n' +
        'Uses the configured Supervisor role; MFAGENT_REPLAY_BASE_URL, MODEL, API_KEY, EFFORT, PROVIDER, STATE_DB and CORE override it.\n' +
        'No source task edits. The backup and redacted report remain in a new temporary directory.\n');
      return;
    }
    return replay(options);
  }).catch(error => { process.stderr.write(sanitized(error, process.env.MFAGENT_REPLAY_API_KEY) + '\n'); process.exitCode = 1; });
}

module.exports = { parseArgs, sourceReceipt, replay };
