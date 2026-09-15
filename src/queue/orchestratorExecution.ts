import { executeTask, ExecutionOutcome } from './agents';
import type { Task } from './db';
import { appendAttempt, stopDetail, TEST_OWNERSHIP_STOP } from './orchestratorState';
import { OrchestratorVerification } from './orchestratorVerification';
import { completionForSupervisor } from './validation';
import { scopeBlocked } from './scopePlan';
import { providerConfigurationError } from './recovery';
import { boundedTask } from './scopeBoundary';
import { promptOverloadReason } from './scopeEvidence';

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

    try {
      this.queue.recordActivity(task.id, 'scope_review', 'Reviewing the task before execution', 'supervisor');
      if (!await scope.preflight()) return;
      if (!current()) return;
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
        (method, params) => { journal.onEvent(method, params); scope.observe(method, params); },
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
      // The executor is the only agent that decides a task is done: a closing
      // READY_FOR_VALIDATION claim on a complete turn ends the task. Everything
      // else is partial work and goes back for another attempt.
      const done = !res.cutOff && res.ok && !overload &&
        res.completion.status === 'READY_FOR_VALIDATION';
      const outcome: Partial<Task> = {
        output: res.text,
        validationReport: '',
        activityPhase: done ? 'done' : repairDetail ? 'needs_review' : 'needs_work',
        finishedAt: done ? Date.now() : null,
        ...(cutOffNote ? { errorLog: cutOffNote } : {}),
        ...(repairDetail ? { supervisorFeedback: `[SUPERVISOR_TEST_REPAIR] ${repairDetail}` } : {}),
      };
      const applied = this.queue.finishExecution(
        task.id,
        attempt,
        done ? { ...outcome, status: 'VERIFIED' }
          : repairDetail ? { ...outcome, status: 'VERIFYING' }
          : this.retryPatch(task, outcome,
              overload || res.stopReason || res.completion.status || 'executor reported unfinished work'),
      );
      if (!applied) {
        this.log(`task ${task.seq} — result arrived after the run moved past this attempt; discarding it`);
      } else {
        this.queue.log(
          task.id,
          'executor',
          done ? 'completed' : res.cutOff ? 'cut-off' : 'unfinished',
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
        if (done) {
          this.recordSharedMemory(task, res);
          this.log(`task ${task.seq} complete — execution is the final step`);
        } else if (repairDetail) {
          this.queue.log(task.id, 'executor', 'test-repair-requested', repairDetail);
          this.log(`task ${task.seq} — executor stopped on a supervisor-owned test; ` +
            'a supervisor repair turn is queued');
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
        this.queue.recordActivity(task.id, 'stopped', msg);
        this.queue.log(task.id, 'executor', 'stopped', msg);
        this.log(`task ${task.seq} stopped without reporting: ${msg}; returned for another attempt`);
      } else {
        this.log(`task ${task.seq} — its worker stopped after the run moved past this attempt; ignoring it`);
      }
    } finally {
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

  /** Keep unfinished work at its original position, with cumulative attempt history. */
  private retryPatch(task: Task, outcome: Partial<Task>, reason: string): Partial<Task> {
    const errorLog = appendAttempt(
      (outcome.errorLog as string | undefined) ?? task.errorLog,
      `[attempt ${task.attempts}] ${reason}`,
    );
    return { ...outcome, status: 'PENDING', finishedAt: null, activityPhase: 'requeued', errorLog };
  }

  /**
   * Records a compact, durable outcome in the queue's shared notes, so every
   * later task session starts with what this one accomplished — the same
   * cross-session memory as the workspace graph, kept where a fresh worker is
   * guaranteed to read it.
   */
  private recordSharedMemory(task: Task, res: ExecutionOutcome): void {
    const claim = res.completion;
    const summary = (claim.summary || res.text).replace(/\s+/g, ' ').trim().slice(0, 800);
    const files = claim.filesChanged.slice(0, 12).join(', ');
    const line = `task ${task.seq} "${task.title}" complete${files ? ` — files: ${files}` : ''}: ${summary}`;
    this.queue.appendInstruction(line, `task ${task.seq} outcome`);
    this.queue.log(task.id, 'executor', 'shared-memory', line.slice(0, 8000));
  }
}
