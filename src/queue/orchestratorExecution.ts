import { executeTask } from './agents';
import { appendAttempt } from './orchestratorState';
import { OrchestratorVerification } from './orchestratorVerification';
import { completionForSupervisor } from './validation';
import { scopeBlocked } from './scopePlan';

export abstract class OrchestratorExecution extends OrchestratorVerification {

  // ---- the execution pump ----------------------------------------------

  /**
   * Starts a worker on the next PENDING task, if one should start now.
   *
   * In lockstep mode nothing starts while a task is awaiting verification, so
   * task N+1 is never built on top of unverified task N. Continuous mode lets
   * later executors may run ahead while conclusion checks follow behind.
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
    if (this.mode === 'lockstep' && this.queue.awaitingVerification().length > 0) {
      return;
    }

    const next = this.queue.list().find(task => task.status === 'PENDING');
    if (next && scopeBlocked(next, this.queue.list())) return;
    const task = this.queue.claimNext();
    if (!task) {
      if (this.queue.isComplete()) {
        this.finish();
      }
      return;
    }

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
        void this.pump();
      }
      return;
    }

    this.log(`executing task ${task.seq} — ${task.title} (attempt ${task.attempts})`);

    const journal = this.streamJournal(task.id, 'executor', current);
    journal.live.note('attempt', `attempt ${task.attempts} started`);
    const scope = this.scopeWatch(task, 'executor', current, (phase, detail) => {
      this.queue.recordActivity(task.id, phase, detail, 'supervisor');
    });
    this.executionScope = scope;

    try {
      this.queue.recordActivity(task.id, 'scope_review', 'Assessing task and verification scope before execution', 'supervisor');
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
        task,
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
      // between a task that needs splitting and one whose tool calls are broken.
      const cutOffNote = res.cutOff
        ? appendAttempt(
            task.errorLog,
            `[attempt ${task.attempts}] the core stopped the turn (${res.stopReason}). ` +
              'The report is partial progress. The supervisor must decide whether to ' +
              'continue, rewrite, split, or validate.',
          )
        : undefined;

      this.queue.addUsage(task.id, res.usage);
      const applied = this.queue.finishExecution(task.id, attempt, {
        status: 'VERIFYING',
        output: res.text,
        // Empty means the supervisor has not delegated formal verification yet.
        validationReport: '',
        activityPhase: !res.cutOff && res.completion.status === 'READY_FOR_VALIDATION'
          ? 'ready_for_validation' : 'needs_review',
        ...(cutOffNote ? { errorLog: cutOffNote } : {}),
      });
      if (!applied) {
        this.log(`task ${task.seq} — result arrived after the run moved past this attempt; discarding it`);
      } else {
        this.queue.log(
          task.id,
          'executor',
          res.cutOff ? 'cut-off' : 'completed',
          res.text.slice(0, 4000),
        );
        // Recorded separately from the raw reply, and normalised: this is the
        // one thing in the reply the supervisor's next decision turns on, and
        // it should not depend on the supervisor finding it inside prose.
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
        this.log(
          res.cutOff
            ? `task ${task.seq} — the core stopped the turn (${res.stopReason}); awaiting a supervisor action`
            : `task ${task.seq} implementation agent stopped claiming ${res.completion.status}; ` +
              'awaiting a supervisor action',
        );
      }
    } catch (e: any) {
      journal.flush();
      if (!current()) return;
      const msg = String(e?.message ?? e);
      journal.live.note('error', `stopped: ${msg}`);
      // A worker that died mid-turn — a dropped connection, a crashed core, or
      // abandonExecution killing it on purpose — still edited real files. Send
      // it to the supervisor with an empty validation report. The supervisor
      // uses the journal and any needed tools to decide recovery; completion
      // still requires an independent verification report.
      const applied = this.queue.finishExecution(task.id, attempt, {
        status: 'VERIFYING',
        output: task.output,
        errorLog: appendAttempt(
          task.errorLog,
          `[attempt ${task.attempts}] the worker stopped before reporting: ${msg}. ` +
            "Whatever it changed is still on disk — read the files, and read this task's " +
            'activity log, rather than assuming nothing happened.',
        ),
      });
      if (applied) {
        this.queue.recordActivity(task.id, 'stopped', msg);
        this.queue.log(task.id, 'executor', 'stopped', msg);
        this.log(`task ${task.seq} stopped without reporting: ${msg}; awaiting supervision`);
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
      void this.pump();
    }
  }
}
