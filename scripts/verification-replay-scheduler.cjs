// Actual Start/tick/recovery/verification against the caller's isolated queue.
async function drive(load, queue, task, options) {
  const { Orchestrator } = load('src/queue/orchestrator.ts');
  const { readRecoveryJob } = load('src/queue/recoverySchedule.ts');
  const runner = Object.create(Orchestrator.prototype);
  const logs = [], snapshots = [], verificationReports = [], seenReports = new Set();
  const started = Date.now();
  const captureReport = () => {
    const current = queue.get(task.id);
    const serialized = current?.validationReport;
    if (!serialized || serialized === task.validationReport || seenReports.has(serialized)) return;
    seenReports.add(serialized);
    verificationReports.push({ elapsedMs: Date.now() - started, serialized });
  };
  const priorInterval = queue.cronIntervalSeconds;
  // Test-clock frequency only; task acceptance and durable backoff stay intact.
  queue.setCronIntervalSeconds(10);
  Object.assign(runner, { queue, context: {}, output: { appendLine(text) { logs.push(text); } },
    changed: captureReport, reviewed: new Map(), executionGen: 0, reviewGen: 0, cycle: 0,
    disposed: false, supervising: false, review: null, executionAbort: null });
  const maxCycles = Math.max(1, Math.min(3, Number(options['max-cycles'] || 2)));
  let lastKey = '', outcome = 'deadline';
  const baselineAttempts = queue.countEvents(task.id, 'recovery-attempt');
  const baselineEvent = queue.events(task.id, 1, true)[0]?.id || 0;
  runner.start();
  try {
    while (Date.now() - started < 900000) {
      captureReport();
      const current = queue.get(task.id);
      const job = current ? readRecoveryJob(queue, current) : undefined;
      const attemptCount = queue.countEvents(task.id, 'recovery-attempt') - baselineAttempts;
      const snapshot = { elapsedMs: Date.now() - started, runState: queue.runState,
        taskStatus: current?.status, activity: current?.activityPhase,
        recoveryAttempts: attemptCount, active: job?.active, dueAt: job?.dueAt,
        lastError: job?.lastError, supervising: runner.supervising };
      const key = JSON.stringify({ ...snapshot, elapsedMs: 0 });
      if (key !== lastKey) {
        snapshots.push(snapshot); lastKey = key;
        process.stderr.write(`Scheduler replay: ${snapshot.runState} ${snapshot.activity} recovery=${attemptCount} active=${job?.active}.\n`);
      }
      if (queue.runState !== 'RUNNING') { outcome = 'unexpected-stop'; break; }
      if (!current) { outcome = 'task-replaced'; break; }
      const recentEvents = options['review-report'] === 'true' ? queue.events(task.id, 40, true) : [];
      const firstNewValidation = recentEvents.find(event => event.id > baselineEvent && event.kind === 'validation');
      if (verificationReports.length && firstNewValidation && recentEvents.some(event =>
        event.id > firstNewValidation.id && event.kind.startsWith('verdict:'))) {
        outcome = 'reviewed-new-verification-report'; break;
      }
      if (options['review-report'] !== 'true' && !runner.supervising &&
          current.validationReport !== task.validationReport && current.validationReport) {
        outcome = 'new-verification-report'; break;
      }
      if (!runner.supervising && attemptCount >= maxCycles) { outcome = 'bounded-recovery-cycles'; break; }
      if (current.attempts > task.attempts) { outcome = 'implementation-boundary'; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    captureReport();
    return { outcome, elapsedMs: Date.now() - started, snapshots, logs, verificationReports,
      runStateBeforeHarnessDisposal: queue.runState, originalCronSeconds: priorInterval,
      replayCronSeconds: 10, events: queue.events(task.id, 120, true),
      queueRunEvents: queue.events(null, 30, true).filter(event => event.kind === 'run-state') };
  } finally {
    // End the bounded test, not the production run. Dispose does not call Stop.
    runner.disposed = true; runner.disarm(); clearInterval(runner.watchdog);
    runner.abandonReview(); runner.abandonExecution();
  }
}

module.exports = { drive };
