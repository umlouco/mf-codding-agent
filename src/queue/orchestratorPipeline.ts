import type { NewTask, Task } from './db';
import { OrchestratorExpansion } from './orchestratorExpansion';
import { appendAttempt, Review } from './orchestratorState';
import { VALIDATION_FAILED } from './monitor';
import { LiveLog } from './liveLog';
import { runTester } from './tester';
import { decideAfterTest, TestVerdict, verdictFacts } from './supervisorDecision';
import { providerConfigurationError, providerUnavailable } from './recovery';
import { recoverOwnershipStop } from './ownershipRecovery';
import { hasOutstandingRecovery } from './recoverySchedule';
import { storedValidationProblem, serializeValidation } from './validation';
import { boundedTask } from './scopeBoundary';

/**
 * The supervised pipeline: the supervisor as orchestrator of coder and tester.
 *
 * The shape follows the 2026 agent frameworks the queue borrows from — a
 * LangGraph-style supervisor graph over durable state, an OpenClaw-style cron
 * heartbeat that wakes the supervisor, and a Hermes-style evidence gate on
 * completion:
 *
 *   planner ─▶ PENDING ─claim─▶ EXECUTING (coder) ──READY──▶ VERIFYING
 *                 ▲               │  ▲ live review: steer / stop /     │ no report
 *                 │               │  └ rewrite / split  (supervisor)   ▼
 *                 │               ▼                                 tester
 *                 │        NEEDS_MORE_WORK                             │ report
 *                 │                                                    ▼
 *                 └── RETRY / REWRITE / SPLIT ◀── decide ◀── FAIL / INCOMPLETE
 *                            RETEST ─▶ tester again      PASS + executed checks ─▶ VERIFIED
 *
 * Every edge that can be decided from recorded facts is decided in code: which
 * lane runs next, whether a PASS is backed by executed checks, which actions a
 * decision may choose. The supervisor model is asked only for judgement — live
 * direction of a running coder (monitor.ts) and what to do after a failed test
 * (supervisorDecision.ts) — and its replies are validated against the graph.
 *
 * Each cycle is one `tick()`: fired by the cron, by the watchdog, and
 * immediately after every handoff, so a finished coder never waits a whole
 * interval for its tester.
 */
export abstract class OrchestratorPipeline extends OrchestratorExpansion {
  /** A handoff arrived while a cycle was busy; run another step before yielding. */
  private wakePending = false;

  private get maxRetests(): number {
    return Math.max(0, this.cfg<number>('queue.testerMaxRetests', 2));
  }

  // ---- the supervisor cycle --------------------------------------------

  protected async tick(): Promise<void> {
    this.nextTickAt = Date.now() + this.intervalMs;
    if (this.disposed || this.queue.runState !== 'RUNNING') return;
    if (this.runBreakerTripped()) return;
    if (this.supervising) {
      this.wakePending = true;
      return;
    }
    const cycle = ++this.cycle;
    this.supervising = true;
    this.changed();
    try {
      for (let step = 0; step < 8 && this.cycle === cycle; step++) {
        this.wakePending = false;
        const before = this.headSignature();
        const routed = await this.superviseStep();
        if (this.disposed || this.queue.runState !== 'RUNNING') return;
        // Continue only when the step moved the queue: a lane that returned
        // without changing the head row would otherwise spin this loop.
        const moved = this.headSignature() !== before;
        if (!(routed && moved) && !this.wakePending) break;
      }
      if (this.cycle === cycle && this.queue.isComplete() && !hasOutstandingRecovery(this.queue)) {
        this.finish();
        return;
      }
    } catch (e: any) {
      this.log(`supervision cycle failed: ${e?.message ?? e}`);
    } finally {
      if (this.cycle === cycle) {
        this.supervising = false;
        this.changed();
      }
    }
    if (this.cycle !== cycle) return;
    this.schedule('execution pump after supervision', () => this.pump());
  }

  /** Identity of the queue head's state, to tell a routing step that moved it from one that did not. */
  private headSignature(): string {
    const rows = this.queue.list();
    const head = rows.find(t => t.status !== 'VERIFIED');
    return head ? `${rows.length}|${head.id}|${head.status}|${head.updatedAt}|${head.validationReport.length}` : `${rows.length}|done`;
  }

  /**
   * One routing step for the task at the head of the queue. Returns whether it
   * changed state in a way the next step can act on straight away.
   */
  private async superviseStep(): Promise<boolean> {
    this.sweepSilentWorkers();
    for (const row of this.queue.list()) recoverOwnershipStop(this.queue, row);
    const task = this.queue.list().find(t => t.status !== 'VERIFIED');
    if (!task) return false;

    // Scheduled recovery and replacement planning own their rows until done.
    if (await this.serviceRecovery(task)) return false;

    if (task.status === 'VERIFYING' && task.supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]')) {
      await this.serviceTestRepairs();
      return true;
    }
    if (task.status === 'EXECUTING') {
      const hasOutcome = this.queue.events(task.id, 200, true)
        .some(event => event.actor === 'executor' && event.kind === 'tool');
      if (hasOutcome) await this.reviewWork(task);
      return false;
    }
    if (task.status !== 'VERIFYING') return false;
    if (!task.validationReport.trim()) {
      await this.runTesterLane(task);
      return true;
    }
    await this.decideVerification(task);
    return true;
  }

  // ---- tester lane -----------------------------------------------------

  /**
   * Every entry into independent verification runs the tester agent. A caller
   * that already owns a fenced review (recovery's VERIFY, a live START_VALIDATION)
   * passes it, so the tester runs under that review instead of superseding it.
   */
  protected async verifyWithExecutor(task: Task, review?: Review): Promise<void> {
    await this.runTesterLane(task, review);
  }

  private sameContract(current: Task | undefined, snapshot: Task): boolean {
    return !!current && current.status === 'VERIFYING' &&
      (['startedAt', 'attempts', 'description', 'solutionVerifyPrompt', 'output', 'validationReport'] as const)
        .every(key => current[key] === snapshot[key]);
  }

  protected async runTesterLane(snapshot: Task, owner?: Review): Promise<void> {
    const task = this.queue.get(snapshot.id);
    if (!task || task.status !== 'VERIFYING') return;
    const review: Review = owner ?? { taskId: task.id, seq: task.seq, gen: ++this.reviewGen, lastActivityAt: Date.now(), startedAt: Date.now() };
    if (!owner) this.review = review;
    const accepts = () => review.gen === this.reviewGen && this.sameContract(this.queue.get(task.id), task);
    const journal = this.streamJournal(task.id, 'validator', accepts);
    this.queue.log(task.id, 'validator', 'tester-started', `attempt ${task.attempts}: independent tester verifying the coder's result`);
    this.queue.recordActivity(task.id, 'testing', 'The tester is verifying this task', 'validator');
    this.log(`task ${task.seq} — tester started`);
    this.changed();
    try {
      const result = await runTester(this.context, this.output, boundedTask(task), this.queue.getMeta('goal'),
        this.queue.testingContext + this.queue.instructions, {
          onActivity: activity => {
            if (!accepts()) return;
            review.lastActivityAt = activity.at;
            journal.live.activity(activity);
            if (this.queue.recordActivity(task.id, activity.phase, activity.detail, 'validator')) this.changed();
          },
          onEvent: (method, params) => { if (accepts()) journal.onEvent(method, params); },
          onAbort: abort => { if (!accepts()) { abort(); return; } review.abort = abort; },
        });
      journal.flush();
      if (!accepts()) {
        this.log(`task ${task.seq} moved while the tester ran; its report is ignored`);
        return;
      }
      this.queue.addUsage(task.id, result.usage);
      this.storeTesterReport(task, result.serialized);
      this.queue.log(task.id, 'validator', 'response', result.text.slice(0, 8000));
      this.queue.log(task.id, 'validator', 'validation', result.serialized.slice(0, 8000));
      this.log(`task ${task.seq} — tester: ${result.report.conclusion}` +
        (result.executed.length ? ` (${result.executed.length} executed check(s))` : ''));
    } catch (error: any) {
      journal.flush();
      if (!accepts()) return;
      if (error?.usage) this.queue.addUsage(task.id, error.usage);
      const message = String(error?.message ?? error);
      this.queue.log(task.id, 'validator', VALIDATION_FAILED, message);
      if (providerConfigurationError(message)) { this.stopForProviderConfiguration(message); return; }
      if (providerUnavailable(message)) { this.pauseForRecovery(task, message); return; }
      // The tester itself failed. That is not evidence about the code; record it
      // as INCOMPLETE so the decision node can choose RETEST instead of RETRY.
      this.storeTesterReport(task, serializeValidation({ conclusion: 'INCOMPLETE', summary: `The tester stopped: ${message}`,
        implementationEvidence: '', behaviorEvidence: '', checks: [], remaining: message }));
      this.log(`task ${task.seq} — tester stopped: ${message}`);
    } finally {
      journal.live.close();
      if (!owner && this.review === review) this.review = null;
      this.changed();
    }
  }

  private storeTesterReport(task: Task, serialized: string): void {
    this.queue.update(task.id, { validationReport: serialized, activityPhase: 'tested' });
    const current = this.queue.get(task.id)!;
    this.queue.setMeta(`verificationAccepted:${task.id}`,
      JSON.stringify([this.verificationIdentity(current), current.validationReport]));
  }

  // ---- post-test decision ----------------------------------------------

  private attemptEvents(task: Task, kind: string): number {
    return this.queue.events(task.id, 500).filter(e => e.kind === kind && e.message.startsWith(`attempt ${task.attempts}:`)).length;
  }

  protected async decideVerification(task: Task): Promise<void> {
    const problem = storedValidationProblem(task.validationReport);
    if (!problem && this.currentHostVerification(task)) {
      // PASS with executed evidence, produced by this host for this contract:
      // accepted by code. No model is asked to agree with a proven result.
      this.queue.update(task.id, { status: 'VERIFIED', finishedAt: Date.now(), activityPhase: 'done',
        supervisorFeedback: 'The independent tester passed every acceptance check.' });
      this.queue.log(task.id, 'supervisor', 'verdict:VERIFIED', 'Tester PASS backed by executed checks.');
      this.recordSharedMemory(this.queue.get(task.id) ?? task);
      this.reviewed.delete(task.id);
      this.log(`task ${task.seq} VERIFIED by the tester`);
      this.changed();
      return;
    }
    if (!problem) {
      // A PASS this host did not produce (legacy row, edited contract): test again.
      this.queue.update(task.id, { validationReport: '' });
      return;
    }

    const review: Review = { taskId: task.id, seq: task.seq, gen: ++this.reviewGen, lastActivityAt: Date.now(), startedAt: Date.now() };
    this.review = review;
    const live = new LiveLog(this.queue, task.id, 'supervisor');
    const accepts = () => review.gen === this.reviewGen && this.sameContract(this.queue.get(task.id), task);
    this.queue.recordActivity(task.id, 'deciding', `The supervisor is deciding after the tester: ${problem}`, 'supervisor');
    this.log(`task ${task.seq} — supervisor deciding after the tester (${problem})`);
    let verdict: TestVerdict;
    try {
      verdict = await decideAfterTest(this.context, this.output, task,
        this.queue.list().map(t => ({ seq: t.seq, title: t.title, status: t.status })),
        this.queue.getMeta('goal'), this.queue.testingContext + this.queue.instructions,
        verdictFacts(task, this.attemptEvents(task, 'tester-retest'),
          this.queue.countEvents(task.id, 'test-repair-halted'), this.maxRetests),
        {
          onEvent: this.observerEvents(task.id, 'supervisor', live, accepts),
          onAbort: abort => { if (!accepts()) { abort(); return; } review.abort = abort; },
        });
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (accepts() && providerUnavailable(message)) this.pauseForRecovery(task, message);
      this.log(`task ${task.seq} — supervisor decision failed: ${message}`);
      return;
    } finally {
      live.close();
      if (this.review === review) this.review = null;
    }
    if (!accepts()) {
      this.log(`task ${task.seq} moved while the supervisor decided; decision ignored`);
      return;
    }
    this.queue.addUsage(task.id, verdict.usage);
    this.queue.log(task.id, 'supervisor', `verdict:${verdict.action}`,
      `attempt ${task.attempts}: ${verdict.reason}${verdict.fallback ? ' (fallback)' : ''}`);
    await this.applyVerdict(task, verdict);
    this.changed();
  }

  private async applyVerdict(task: Task, verdict: TestVerdict): Promise<void> {
    const note = `[attempt ${task.attempts}] tester did not pass; supervisor ${verdict.action}: ${verdict.reason}`;
    switch (verdict.action) {
      case 'RETRY':
        this.queue.update(task.id, { status: 'PENDING', finishedAt: null, activityPhase: 'requeued',
          supervisorFeedback: verdict.guidance, errorLog: appendAttempt(task.errorLog, note) });
        this.log(`task ${task.seq} back to the coder: ${verdict.reason}`);
        return;
      case 'REWRITE':
        if (this.holdRewriteForOwner(task, `new description: ${verdict.rewrittenDescription || '(unchanged)'}; ` +
          `new verification: ${verdict.solutionVerifyPrompt || '(unchanged)'}`)) return;
        this.queue.update(task.id, { status: 'PENDING', finishedAt: null, activityPhase: 'requeued',
          description: verdict.rewrittenDescription || task.description,
          solutionVerifyPrompt: verdict.solutionVerifyPrompt || task.solutionVerifyPrompt,
          validationReport: '', supervisorFeedback: verdict.guidance || verdict.reason, attempts: 0,
          errorLog: appendAttempt(task.errorLog, note) });
        this.queue.log(task.id, 'supervisor', 'task-edited', (verdict.rewrittenDescription || verdict.solutionVerifyPrompt || '').slice(0, 8000));
        this.log(`task ${task.seq} rewritten by the supervisor and returned to the coder`);
        return;
      case 'RETEST':
        this.queue.log(task.id, 'supervisor', 'tester-retest', `attempt ${task.attempts}: ${verdict.guidance}`);
        this.queue.update(task.id, { validationReport: '', activityPhase: 'awaiting_tester',
          supervisorFeedback: `${verdict.guidance}\nPrevious tester report: ${task.validationReport.slice(0, 3000)}` });
        this.log(`task ${task.seq} — tester runs again: ${verdict.reason}`);
        return;
      case 'REPAIR_TESTS':
        await this.repairTests(task, verdict.guidance || verdict.reason);
        return;
      case 'SPLIT': {
        if (verdict.splitInto?.length) {
          try {
            this.splitTask(task.id, verdict.splitInto as NewTask[]);
            this.log(`task ${task.seq} split into ${verdict.splitInto.length} tasks by the supervisor`);
            return;
          } catch (error) {
            this.log(`task ${task.seq} — split could not be committed (${String(error)}); planning a replacement instead`);
          }
        }
        this.requestFailureDecomposition(this.queue.get(task.id) ?? task, `${verdict.reason}\n${verdict.guidance}`.trim());
        return;
      }
    }
  }
}
