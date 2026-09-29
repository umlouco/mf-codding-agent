import { attemptsExhausted, executeTask } from './agents';
import type { Task } from './db';
import { appendAttempt, stopDetail, TEST_OWNERSHIP_STOP } from './orchestratorState';
import { OrchestratorVerification } from './orchestratorVerification';
import { completionForSupervisor, parseCompletionClaim } from './validation';
import { scopeBlocked } from './scopePlan';
import { providerConfigurationError, providerUnavailable } from './recovery';
import { boundedTask } from './scopeBoundary';
import { promptOverloadReason } from './scopeEvidence';
import { clearScopeRetry } from './scopeRetry';

export abstract class OrchestratorExecution extends OrchestratorVerification {

  // ---- the execution pump ----------------------------------------------

  /**
   * Starts a worker on the next PENDING task, if one should start now.
   *
   * Both modes finish the earliest unresolved task before claiming later work.
   * Continuous mode schedules the next eligible execution immediately.
   *
   * "At most one worker at a time" is not enforced here. `claimNext` refuses
   * to hand out a task while any row is EXECUTING, so calling this twice at
   * once — the cron tick and the watchdog firing together, say — costs a
   * wasted query on the loser, never a second worker. That is also what makes
   * this call safe to repeat after a stop-and-restart: whatever the database
   * says about the previous attempt is what decides whether this one may
   * proceed, not anything remembered from before the restart.
   */
  protected async pump(): Promise<void> {
    if (this.disposed || this.queue.runState !== 'RUNNING') {
      return;
    }
    // One executor at a time: claimNext itself refuses to hand out a task while
    // any row is EXECUTING, so this is safe to call from the cron and the
    // watchdog at once. A task ends when its executor finishes; there is no
    // separate verification stage for later work to wait behind.
    if (this.runBreakerTripped()) return;
    this.queue.recoverBlocked();
    const next = this.queue.list().find(task => task.status === 'PENDING');
    if (next && scopeBlocked(next, this.queue.list())) return;
    // A row whose budget is already spent must not be claimed again: the
    // executor-path pause stops an attempt that spends the budget in this
    // process, but a row reloaded from the database would otherwise be
    // re-executed at full cost before it could stop — the observed "attempt 7
    // of 3" loop. The one claim that is still allowed is a preflight deferral,
    // which uses the `scope_waiting` phase and keeps backing off on its own.
    if (next && next.activityPhase !== 'scope_waiting' && attemptsExhausted(next)) {
      this.splitExhaustedAttempts(next, 'its attempt budget was already spent before this claim');
      return;
    }
    const task = this.queue.claimNext();
    if (!task) {
      if (this.queue.isComplete()) {
        this.finish();
      }
      return;
    }

    if (this.correctTestingTarget(task)) return;

    // Attempts may reset after a rewrite. Process generation and the committed
    // claim identity fence callbacks as well as final results; old workers cannot
    // release the replacement's abort handle or contaminate its journal.
    const attempt = task.attempts;
    const gen = this.executionGen = (this.executionGen ?? 0) + 1;
    this.executionSteer = null;
    const current = () => this.executionGen === gen && this.queue.get(task.id)?.status === 'EXECUTING' &&
      this.queue.get(task.id)?.startedAt === task.startedAt;
    this.changed();

    // A phase is a coarse slice of the plan awaiting expansion into real
    // tasks, not work to execute — see TaskKind. It shares this same claim so
    // that everything below (the cron ordering, requeueStale, silentWorkers,
    // the watchdog) covers phase-expansion crashes for free.
    if (task.kind === 'phase') {
      await this.runExpansion(task, attempt, gen, current);
      if (this.mode === 'continuous') {
        this.schedule('continuous execution pump', () => this.pump());
      }
      return;
    }

    this.log(`executing task ${task.seq} — ${task.title} (attempt ${task.attempts})`);

    const journal = this.streamJournal(task.id, 'executor', current);
    journal.live.note('attempt', `attempt ${task.attempts} started`);

    // The supervisor inspects the task contract before any executor starts and
    // may replace a multi-item task with one bounded task per item. It reports
    // activity as 'supervisor' so a long preflight is not mistaken for a silent
    // worker; see ScopeSupervisor.preflight.
    const scope = this.scopeWatch(task, 'executor', current, (phase, detail) => {
      if (!current()) return;
      if (this.queue.recordActivity(task.id, phase, detail, 'supervisor')) this.changed();
    });
    this.executionScope = scope;

    let preflightComplete = false;
    try {
      this.queue.recordActivity(task.id, 'scope_review', 'Reviewing the task before execution', 'supervisor');
      if (!await scope.preflight()) return;
      if (!current()) return;
      preflightComplete = true;
      clearScopeRetry(this.queue, task);
      this.queue.recordActivity(task.id, 'starting', 'Scope reviewed; starting executor');
      // Every record the worker writes lands in the database as it happens, so
      // the run is legible while it is still going and survives the process
      // that produced it. This is also the only thing keeping the task off the
      // silent list — see sweepSilentWorkers.
      const res = await executeTask(
        this.context,
        this.output,
        boundedTask(task),
        this.queue.contextInstructions,
        this.queue.getMeta('goal'),
        (a) => {
          if (!current()) return;
          journal.live.activity(a);
          if (this.queue.recordActivity(task.id, a.phase, a.detail)) {
            this.changed();
          }
        },
        (method, params) => journal.onEvent(method, params),
        (abort) => {
          if (!current()) { abort(); return; }
          this.executionAbort = abort;
        },
        steer => { if (current()) this.executionSteer = text => current() ? steer(text) : Promise.resolve(false); },
      );
      journal.flush();
      if (!current()) return;

      // The core stopped this turn itself rather than the model finishing it —
      // see coreHalted. The report is partial progress, so say which limit it
      // ran into: the retry prompt feeds this back, and it is the difference
      // between a task that needs another attempt and one whose tool calls are
      // broken.
      const cutOffNote = res.cutOff
        ? appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] the core stopped the turn (${res.stopReason})` +
              (stopDetail(res.text) ? `: ${stopDetail(res.text)}` : '') +
              '. The report is partial progress. The task will be retried with this history.',
          )
        : undefined;

      this.queue.addUsage(task.id, res.usage);
      const overload = promptOverloadReason(res.text);
      // Older cores may still reject test edits. Hand their ownership stops to
      // the supervisor lane, where ownership migration or a repair can resolve them.
      const repairDetail = res.cutOff && res.stopReason === 'supervisor_repair_required' &&
        TEST_OWNERSHIP_STOP.test(stopDetail(res.text)) ? stopDetail(res.text) : undefined;
      // The coder never decides a task is done. A closing READY_FOR_VALIDATION
      // claim on a complete turn hands the task to the tester (VERIFYING with no
      // report); the supervisor's next cycle runs the tester and only a PASS
      // backed by executed checks makes it VERIFIED. Anything else is partial
      // work and goes back to the coder.
      const handoff = !res.cutOff && res.ok && !overload &&
        res.completion.status === 'READY_FOR_VALIDATION';
      const outcome: Partial<Task> = {
        output: res.text,
        validationReport: '',
        activityPhase: handoff ? 'awaiting_tester' : repairDetail ? 'needs_review' : 'needs_work',
        finishedAt: null,
        ...(cutOffNote ? { errorLog: cutOffNote } : {}),
        ...(repairDetail ? { supervisorFeedback: `[SUPERVISOR_TEST_REPAIR] ${repairDetail}` } : {}),
      };
      const exhausted = !handoff && !repairDetail && attemptsExhausted(task);
      const applied = this.queue.finishExecution(
        task.id,
        attempt,
        handoff || repairDetail ? { ...outcome, status: 'VERIFYING' }
          : exhausted ? { ...outcome, status: 'PENDING' }
            : this.retryPatch(task, outcome,
                overload || res.stopReason || res.completion.status || 'executor reported unfinished work'),
      );
      if (!applied) {
        this.log(`task ${task.seq} — result arrived after the run moved past this attempt; discarding it`);
      } else {
        this.abandonReviewOf(task.id);
        this.queue.log(
          task.id,
          'executor',
          handoff ? 'completed' : res.cutOff ? 'cut-off' : 'unfinished',
          res.text.slice(0, 4000),
        );
        // Recorded separately from the raw reply, and normalised: a durable,
        // machine-readable statement of what the executor says it did.
        this.queue.log(
          task.id,
          'executor',
          'completion-claim',
          completionForSupervisor(res.completion),
        );
        // The hand-off to every later task — see TaskQueue.instructions.
        if (res.notes) {
          this.queue.appendInstruction(res.notes, `task ${task.seq}, attempt ${task.attempts}`);
          this.queue.log(task.id, 'executor', 'notes-added', res.notes);
        }
        if (handoff) {
          this.queue.log(task.id, 'supervisor', 'handoff:tester', 'The coder reported the task ready; the tester verifies it next.');
          this.log(`task ${task.seq} implemented — handed to the tester`);
        } else if (repairDetail) {
          this.queue.log(task.id, 'executor', 'test-repair-requested', repairDetail);
          this.log(`task ${task.seq} — executor stopped on a supervisor-owned test; ` +
            'a supervisor repair turn is queued');
        } else if (exhausted) {
          // The budget bounds how long one formulation may be retried. An
          // executor that keeps returning unfinished work never hands off, so
          // no test phase runs to spend the budget and the row was requeued
          // forever (observed: "attempt 7 of 3", ~29 minutes and 5M input
          // tokens per attempt). The task has failed: it is replaced by
          // smaller ones, never parked for an owner; see splitExhaustedAttempts.
          this.splitExhaustedAttempts(this.queue.get(task.id)!,
            `${overload || res.stopReason || res.completion.status || 'unfinished'} work`);
        } else {
          this.log(
            `task ${task.seq} did not complete (${overload || res.stopReason || res.completion.status}); ` +
              'returned for another attempt',
          );
        }
      }
    } catch (e: any) {
      journal.flush();
      if (!current()) return;
      const msg = String(e?.message ?? e);
      journal.live.note('error', `stopped: ${msg}`);
      // An unconfigured (or role-incompatible) provider is not a worker that
      // died mid-turn: there was never a turn. Every task would fail the same
      // way, so stop the run with the actual fault.
      if (providerConfigurationError(msg)) {
        this.stopForProviderConfiguration(msg);
        return;
      }
      // A provider that is momentarily unreachable — a dropped connection, a
      // 429, or a quota/credit refusal such as OpenRouter's 402 or the Claude
      // CLI spend limit — is not a task-contract problem. Deferring the scope
      // review and retrying re-ran the same failing request on every backoff
      // (the run spun on the outage instead of stopping); pause for recovery
      // exactly as the test and execution phases already do.
      if (providerUnavailable(msg)) {
        this.pauseForRecovery(task, msg);
        return;
      }
      if (!preflightComplete) {
        const retry = this.queue.deferScopeReview(task, msg,
          appendAttempt(task.errorLog, `[attempt ${attempt}] scope review failed: ${msg}`));
        if (retry) {
          const detail = `${msg}\nFresh scope review after ${new Date(retry.dueAt).toISOString()} ` +
            `(failure ${retry.failures}); executor has not started.`;
          this.queue.recordActivity(task.id, 'scope_waiting', detail, 'supervisor');
          this.queue.log(task.id, 'supervisor', 'scope-deferred', detail);
          this.log(`task ${task.seq}: ${detail}`);
        }
        // The normal cron services the durable deadline. Do not wake an
        // immediate pump in either lockstep or continuous mode.
        return;
      }
      // A worker that died mid-turn — a dropped connection, a crashed core, or
      // abandonExecution killing it on purpose — still edited real files, so
      // the task is returned for another attempt with its history; the
      // keep-alive supervisor exists to make sure it runs again.
      const outcome: Partial<Task> = {
        output: task.output,
        errorLog: appendAttempt(
          task.errorLog,
          `[attempt ${task.attempts}] the worker stopped before reporting: ${msg}. ` +
            "Whatever it changed is still on disk — read the files, and read this task's " +
            'activity log, rather than assuming nothing happened.',
        ),
      };
      const applied = this.queue.finishExecution(
        task.id,
        attempt,
        this.retryPatch(task, outcome, 'worker stopped before reporting'),
      );
      if (applied) {
        this.abandonReviewOf(task.id);
        this.queue.recordActivity(task.id, 'stopped', msg);
        this.queue.log(task.id, 'executor', 'stopped', msg);
        this.log(`task ${task.seq} stopped without reporting: ${msg}; returned for another attempt`);
      } else {
        this.log(`task ${task.seq} — its worker stopped after the run moved past this attempt; ignoring it`);
      }
    } finally {
      scope.close();
      journal.live.close();
      if (this.executionGen === gen) { this.executionAbort = null; this.executionScope = undefined; }
      this.changed();
    }

    if (this.executionGen === gen) this.wakeAfterHandoff();
    // Continuous mode keeps going without waiting for the cron. pump() will
    // no-op on its own if the database says there is nothing left to claim.
    if (this.mode === 'continuous') {
      this.schedule('continuous execution pump', () => this.pump());
    }
  }

  /**
   * A live review judges a running attempt. Once the attempt has ended, its verdict can only be
   * discarded ("moved while its progress was reviewed"), yet the supervision cycle stays parked on
   * it: the tester for the finished work waited out a review of work that no longer existed
   * (observed: a $1, five-minute Claude turn in front of every handoff). Drop it now.
   */
  protected abandonReviewOf(taskId: number): void {
    if (this.review?.taskId === taskId) this.abandonReview();
  }

  /** Keep unfinished work at its original position, with cumulative attempt history. */
  private retryPatch(task: Task, outcome: Partial<Task>, reason: string): Partial<Task> {
    const errorLog = appendAttempt(
      (outcome.errorLog as string | undefined) ?? task.errorLog,
      `[attempt ${task.attempts}] ${reason}`,
    );
    return { ...outcome, status: 'PENDING', finishedAt: null, activityPhase: 'requeued', errorLog };
  }

  /**
   * Records a compact, durable outcome in the queue's shared notes once a task is
   * VERIFIED, so every later task session starts with what this one accomplished — the same
   * cross-session memory as the workspace graph, kept where a fresh worker is
   * guaranteed to read it.
   */
  protected recordSharedMemory(task: Task): void {
    const claim = parseCompletionClaim(task.output);
    const summary = (claim.summary || task.output).replace(/\s+/g, ' ').trim().slice(0, 800);
    const files = claim.filesChanged.slice(0, 12).join(', ');
    const line = `task ${task.seq} "${task.title}" complete${files ? ` — files: ${files}` : ''}: ${summary}`;
    this.queue.appendInstruction(line, `task ${task.seq} outcome`);
    this.queue.log(task.id, 'executor', 'shared-memory', line.slice(0, 8000));
  }
}
