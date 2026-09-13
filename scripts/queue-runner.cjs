#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('./headless-host.cjs');
const repo = path.resolve(__dirname, '..');

/** Fill missing process env vars from repo/.env so OPENROUTER_API_KEY etc. reach the host. */
function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1);
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch { /* no .env is fine */ }
}

/**
 * A run needs a usable provider for the roles it will actually call. Fail here,
 * once, with the fix, instead of launching every executor turn into the same
 * "no supported provider" error until the supervisor has rewritten the whole
 * queue into smaller copies of work that can never run.
 */
function preflight(host) {
  return host.store.resolveAll().then(resolved => {
    const usable = role => {
      const r = resolved[role];
      return !!r && !!r.profile && (r.kind !== 'openai-compatible' || !!r.baseURL);
    };
    const missing = ['planner', 'supervisor', 'executor'].filter(role => !usable(role));
    if (!missing.length) return;
    throw Error(`No usable provider for role(s): ${missing.join(', ')}.\n` +
      'The Claude CLI provider can only serve planner/supervisor. Give the worker roles an OpenAI-compatible\n' +
      'HTTP provider with one of:\n' +
      '  --worker-url <API base> --worker-model <model>   (key: MFAGENT_WORKER_API_KEY)\n' +
      '  MFAGENT_WORKER_URL / MFAGENT_WORKER_MODEL / MFAGENT_WORKER_API_KEY\n' +
      '  OPENROUTER_API_KEY (optionally MFAGENT_WORKER_MODEL)\n' +
      '  OPENAI_API_KEY (optionally MFAGENT_WORKER_MODEL)');
  });
}

async function plan(host, goal) {
  if (host.queue.list().length) throw Error('Planning requires an empty queue; archive the existing queue first.');
  const testing = host.load('src/queue/testingEnvironment.ts');
  const safeGoal = await testing.preparePlanningGoal(host.context, host.queue, goal);
  const live = new (host.load('src/queue/liveLog.ts').LiveLog)(host.queue, null, 'planner');
  try {
    const phases = await host.load('src/queue/agents.ts').planGoal(host.context, host.output, host.queue,
      safeGoal, live.onEvent);
    host.queue.addAll(phases);
    return phases;
  } finally { live.close(); }
}

async function main(argv) {
  if (argv.includes('--help')) {
    console.log('Source queue runner: plan | run | status\n' +
      'node scripts/queue-runner.cjs <command> --workspace <path> [--goal-file <path>] [--instructions-file <path>] [--url <url>] [--model sonnet] [--effort medium] [--cli <path>]\n' +
      'HTTP worker roles: --worker-url <API base> --worker-model <model>; API key: MFAGENT_WORKER_API_KEY.\n' +
      '  Add --worker-all to run planner/supervisor on the worker too (no Claude CLI dependency).\n' +
      'Auto-detected workers: MFAGENT_WORKER_URL/MODEL, or OPENROUTER_API_KEY / OPENAI_API_KEY (+ optional MFAGENT_WORKER_MODEL).\n' +
      'repo/.env is loaded into the environment for missing keys.\n' +
      'Credentials: MFAGENT_CREDENTIAL_USERNAME and MFAGENT_CREDENTIAL_PASSWORD environment variables.\n' +
      'Create a stop-request file at .mfagent/headless.stop to stop safely; run resumes persisted work.');
    return;
  }
  loadDotEnv(path.join(repo, '.env'));
  const command = argv[0], options = {};
  const valued = ['--workspace', '--goal-file', '--instructions-file', '--url', '--model', '--effort', '--cli',
    '--worker-url', '--worker-model'];
  if (!['plan', 'run', 'status'].includes(command)) throw Error('Expected plan, run or status; see --help.');
  for (let index = 1; index < argv.length;) {
    const key = argv[index];
    if (key === '--worker-all') {
      if (options.workerAll) throw Error('Duplicate argument --worker-all.');
      options.workerAll = true; index += 1; continue;
    }
    if (!valued.includes(key) || argv[index + 1] === undefined) throw Error(`Invalid argument ${key}; see --help.`);
    if (options[key.slice(2)] !== undefined) throw Error(`Duplicate argument ${key}.`);
    options[key.slice(2)] = argv[index + 1];
    index += 2;
  }
  if (!options.workspace) throw Error('--workspace is required.');
  if (options.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) throw Error('Invalid --effort.');
  if (command === 'plan' && !options['goal-file']) throw Error('--goal-file is required for planning.');
  const host = await createHost({ ...options, workerUrl: options['worker-url'], workerModel: options['worker-model'],
    workerAll: options.workerAll });
  let poll;
  try {
    // Owner instructions plus a host-verified briefing about the local stack.
    // The briefing is what lets a planner/executor act like someone who knows
    // XAMPP is already installed, instead of guessing paths and re-discovering
    // a broken database one model turn at a time.
    const { environmentBriefing } = require('./wp-xampp.cjs');
    const owner = options['instructions-file'] ? fs.readFileSync(options['instructions-file'], 'utf8') : host.queue.instructions;
    const briefing = environmentBriefing(host.workspace, options.url || host.queue.testingUrl, repo);
    if (owner || briefing) host.queue.setInstructions([owner, briefing].filter(Boolean).join('\n\n'));
    if (command === 'plan') console.log(JSON.stringify(await plan(host, fs.readFileSync(options['goal-file'], 'utf8')), null, 2));
    if (command === 'status') console.log(JSON.stringify({ state: host.queue.runState, stats: host.queue.stats(),
      tasks: host.queue.list().map(t => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, phase: t.activityPhase })) }, null, 2));
    if (command === 'run') {
      await preflight(host);
      await host.load('src/queue/testingEnvironment.ts').loadTestingEnvironment(host.context, host.queue);
      if (!host.queue.list().length) throw Error('Queue is empty; plan first.');
      const stopFile = path.join(host.workspace, '.mfagent', 'headless.stop');
      if (fs.existsSync(stopFile)) throw Error('Remove .mfagent/headless.stop before resuming.');
      await new Promise(resolve => {
        const stop = () => { host.runner.stop(); resolve(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        host.runner.start();
        let last = '';
        poll = setInterval(() => {
          if (fs.existsSync(stopFile)) { stop(); return; }
          const status = JSON.stringify({ state: host.queue.runState, stats: host.queue.stats().byStatus,
            active: host.queue.activeTask()?.title || null });
          if (status !== last) { console.log(status); last = status; }
          if (host.queue.runState !== 'RUNNING') resolve();
        }, 1000);
      });
      if (!host.queue.isComplete()) process.exitCode = 2;
    }
  } finally { clearInterval(poll); await host.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { createHost, plan, main, loadDotEnv, preflight };
