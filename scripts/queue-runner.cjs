#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('./headless-host.cjs');

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
      'HTTP supervisor/executor: --worker-url <API base> --worker-model <model>; API key: MFAGENT_WORKER_API_KEY.\n' +
      'Credentials: MFAGENT_CREDENTIAL_USERNAME and MFAGENT_CREDENTIAL_PASSWORD environment variables.\n' +
      'Create a stop-request file at .mfagent/headless.stop to stop safely; run resumes persisted work.');
    return;
  }
  const command = argv[0], options = {};
  if (!['plan', 'run', 'status'].includes(command)) throw Error('Expected plan, run or status; see --help.');
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--workspace', '--goal-file', '--instructions-file', '--url', '--model', '--effort', '--cli', '--worker-url', '--worker-model'].includes(key) || !argv[index + 1])
      throw Error(`Invalid argument ${key}; see --help.`);
    if (options[key.slice(2)] !== undefined) throw Error(`Duplicate argument ${key}.`);
    options[key.slice(2)] = argv[index + 1];
  }
  if (!options.workspace) throw Error('--workspace is required.');
  if (options.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) throw Error('Invalid --effort.');
  if (command === 'plan' && !options['goal-file']) throw Error('--goal-file is required for planning.');
  const host = await createHost({ ...options, workerUrl: options['worker-url'], workerModel: options['worker-model'] });
  let poll;
  try {
    if (options['instructions-file']) host.queue.setInstructions(fs.readFileSync(options['instructions-file'], 'utf8'));
    if (command === 'plan') console.log(JSON.stringify(await plan(host, fs.readFileSync(options['goal-file'], 'utf8')), null, 2));
    if (command === 'status') console.log(JSON.stringify({ state: host.queue.runState, stats: host.queue.stats(),
      tasks: host.queue.list().map(t => ({ id: t.id, seq: t.seq, title: t.title, status: t.status, phase: t.activityPhase })) }, null, 2));
    if (command === 'run') {
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
module.exports = { createHost, plan, main };
