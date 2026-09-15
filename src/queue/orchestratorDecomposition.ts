import type { NewTask, Task } from './db';
import type { Review } from './orchestratorState';
import { appendAttempt } from './orchestratorState';
import { OrchestratorRecovery } from './orchestratorRecovery';
import { bootstrapTddProblem, decideFailureDecomposition } from './failureDecomposition';
import { LiveLog } from './liveLog';
import { completeRecoveryJob } from './recoverySchedule';
import { plannerIdentity } from './agents';
import { requiresPlaywright } from './playwrightPolicy';
import { verdictReplacementTasks } from './scopeVerdict';
import { mechanicalSplit, normalizeSplitParts } from './splitPlan';
import type { SplitProposal } from './splitPlan';
import { decompositionAncestry, decompositionDigest, decompositionKey, familySplitBudgetLeft,
  readDecomposition, requiresDecomposition, saveDecomposition, scheduleDecomposition } from './recoveryDecomposition';

/** A different planner can repair a rejected proposal; credentials and clock time cannot. */
export function decompositionPlannerIdentity(): string {
  return decompositionDigest(plannerIdentity?.() || []);
}

/**
 * A failed task has one exit: smaller tasks are committed in its place and the
 * original row is deleted, in one transaction.
 *
 * A task fails when its executor stops working, or when the supervisor reads its
 * journal and finds it looping or down a rabbit hole. Every such path calls
 * requestFailureDecomposition, and serviceSplits (every tick, before the pump)
 * commits the replacement. The split always lands: the executor's own proposal
 * or the planner's is used when usable, and mechanicalSplit otherwise.
 */
export abstract class OrchestratorDecomposition extends OrchestratorRecovery {
  /** One split-planner turn may run this long before the host's own split is used. */
  protected splitPlannerTimeoutMs = 300_000;

  protected requireBootstrapRepair(task: Task): boolean {
    if (task.seq !== 1 || task.kind === 'phase' || !requiresPlaywright(this.queue)) return false;
    const problem = bootstrapTddProblem(task.description);
    if (!problem) return false;
    this.requestFailureDecomposition(task, problem);
    return true;
  }

  /**
   * Marks a failed task for replacement by smaller tasks, stopping its executor
   * if one is running. The test-repair marker is cleared on the way: it is what
   * keeps a row in the repair lane, and a row waiting for its split must never
   * be re-requested as a repair on every tick.
   */
  protected requestFailureDecomposition(snapshot: Task, reason: string, proposal?: SplitProposal[]): void {
    const task = this.queue.get(snapshot.id);
    if (!task || task.status === 'VERIFIED' || this.disposed || this.queue.runState !== 'RUNNING') return;
    const pending = requiresDecomposition(task);
    if (!this.stopForDecision(task, { status: 'VERIFYING', finishedAt: null,
      activityPhase: 'decomposition_required', activityDetail: reason.slice(0, 4000),
      ...(task.supervisorFeedback.startsWith('[SUPERVISOR_TEST_REPAIR]') ? { supervisorFeedback: '' } : {}),
      ...(pending ? {} : { errorLog: appendAttempt(task.errorLog,
        `[attempt ${task.attempts}] split requested: ${reason.slice(0, 1500)}`) }),
    })) return;
    // Fence this task's callback without releasing the cycle into a concurrent provider call.
    if (this.review?.taskId === task.id) {
      const old = this.review;
      this.review = null; this.reviewGen++;
      try { old.abort?.(); } catch { /* The completed/rejected turn may already be gone. */ }
    }
    this.recordSplitRequest(task, reason, proposal);
    completeRecoveryJob(this.queue, task);
    if (!pending) this.log(`task ${task.seq} failed; it will be split into smaller tasks: ${reason.slice(0, 300)}`);
    this.changed();
    if (!pending) this.wakeAfterHandoff();
  }

  /** Saves the latest reason, and the failed executor's own proposed split if it made one. */
  protected recordSplitRequest(task: Task, reason: string, proposal?: SplitProposal[]): void {
    const job = readDecomposition(this.queue, task) ?? scheduleDecomposition(this.queue, task, reason);
    job.reason = reason;
    job.awaitingChange = false;
    delete job.plan;
    if (proposal?.length) job.proposal = proposal;
    saveDecomposition(this.queue, task, job);
  }

  /**
   * Replaces the first task waiting for its split. Runs every tick before the
   * pump: a failed task at the head of a lockstep queue holds everything behind
   * it, so it is replaced before any worker starts.
   */
  protected async serviceSplits(): Promise<void> {
    const task = this.queue.list().find(row => row.status !== 'VERIFIED' && requiresDecomposition(row));
    if (task) await this.serviceFailureDecomposition(task);
  }

  /**
   * Replaces a failed task with smaller tasks and deletes it. Always lands: a
   * saved plan or the executor's own proposal first, then one time-limited
   * planner turn, then mechanicalSplit. A family that keeps splitting without a
   * verified result is rebuilt from its original task instead, before anything
   * is spent planning a split the database would refuse.
   */
  protected async serviceFailureDecomposition(snapshot: Task): Promise<boolean> {
    let task = this.queue.get(snapshot.id);
    if (!task || !requiresDecomposition(task)) return false;
    if (this.disposed || this.queue.runState !== 'RUNNING') return true;
    if (!readDecomposition(this.queue, task)) {
      this.recordSplitRequest(task, task.activityDetail || 'The task failed and must be replaced by smaller tasks.');
    }
    const job = readDecomposition(this.queue, task)!;
    if (!familySplitBudgetLeft(this.queue, task)) {
      this.rebuildFromRoot(task, `${job.reason} Its task family has been split repeatedly without a verified result.`);
      return true;
    }
    const ancestry = decompositionAncestry(this.queue, task);
    let parts: NewTask[] | undefined;
    let source = '';
    const candidates: Array<[unknown, string]> = [[job.plan, 'a saved plan'], [job.proposal, "the executor's own proposal"]];
    for (const [candidate, label] of candidates) {
      if (!candidate) continue;
      try { parts = normalizeSplitParts(candidate, task, ancestry); source = label; break; }
      catch (error) {
        this.queue.log(task.id, 'supervisor', 'split-proposal-unusable', `${label}: ${String((error as Error)?.message ?? error)}`);
      }
    }
    if (!parts) {
      const planned = await this.planSplit(task, job.reason, ancestry);
      if (planned === null) return true;
      if (planned) { parts = planned; source = 'the planner'; }
    }
    task = this.queue.get(task.id);
    if (!task || !requiresDecomposition(task) || this.disposed || this.queue.runState !== 'RUNNING') return true;
    if (!parts) { parts = mechanicalSplit(task, job.reason); source = "the host's own split"; }
    const saved = readDecomposition(this.queue, task) ?? job;
    saved.plan = parts;
    saveDecomposition(this.queue, task, saved);
    this.commitSplit(task, parts, saved.reason, source);
    return true;
  }

  /** One time-limited planner turn: usable tasks, undefined when there are none, or null when superseded. */
  private async planSplit(task: Task, reason: string, ancestry: Task[]): Promise<NewTask[] | undefined | null> {
    const review: Review = { taskId: task.id, seq: task.seq, gen: ++this.reviewGen,
      lastActivityAt: Date.now(), startedAt: Date.now(), lastModelOutputAt: Date.now() };
    this.review = review;
    const current = () => review.gen === this.reviewGen && !this.disposed && this.queue.runState === 'RUNNING';
    const live = new LiveLog(this.queue, task.id, 'supervisor');
    const observe = this.observerEvents(task.id, 'supervisor', live, current);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { review.abort?.(); } catch { /* the planner already exited */ }
    }, this.splitPlannerTimeoutMs);
    this.queue.recordActivity(task.id, 'decomposition_planning', 'Planning the smaller tasks that replace this one.', 'supervisor');
    this.changed();
    try {
      const decision = await decideFailureDecomposition(this.context, this.output, task, {
        goal: this.queue.getMeta('goal'),
        requireRunnableSuite: task.seq === 1 && requiresPlaywright(this.queue),
        ownerInstructions: this.queue.contextInstructions + '\n' + this.queue.testingContext + this.queue.instructions,
        evidence: JSON.stringify({ reason, errorLog: task.errorLog, report: task.validationReport.slice(0, 16000),
          events: this.queue.events(task.id, 16, true).map(event => ({ actor: event.actor, kind: event.kind, message: event.message.slice(0, 1500) })),
          remainingQueue: this.queue.list().filter(row => row.id !== task.id)
            .map(row => ({ title: row.title, status: row.status })) }),
        handoff: task.output.slice(0, 8000),
        ancestry: ancestry.map(parent => ({ title: parent.title, description: parent.description,
          solutionVerifyPrompt: parent.solutionVerifyPrompt })),
      }, {
        onAbort: abort => { if (!current() || timedOut) abort(); else review.abort = abort; },
        onEvent: (method, params) => { if (current()) observe(method, params); },
        onActivity: activity => { if (!current()) return; review.lastActivityAt = Date.now(); live.activity(activity); },
      });
      if (!current()) return null;
      this.queue.addUsage(task.id, decision.usage);
      return decision.splitInto;
    } catch (error: any) {
      if (!current()) return null;
      if (error?.usage) this.queue.addUsage(task.id, error.usage);
      const message = timedOut ? `no answer within ${Math.round(this.splitPlannerTimeoutMs / 1000)}s`
        : String(error?.message ?? error);
      this.queue.log(task.id, 'supervisor', 'split-planner-failed', message.slice(0, 4000));
      this.log(`task ${task.seq}: split planner failed (${message.slice(0, 200)}); using the host's own split`);
      return undefined;
    } finally {
      clearTimeout(timer);
      live.close();
      if (this.review === review) this.review = null;
    }
  }

  /** Commits the smaller tasks in the failed task's place and deletes it, in one transaction. */
  protected commitSplit(task: Task, parts: NewTask[], reason: string, source: string): boolean {
    const archiveKey = `scopeSplit:${task.id}:${task.startedAt ?? task.createdAt}:split:${Date.now()}`;
    const replacements = verdictReplacementTasks(parts, task, archiveKey);
    // Archive before the transaction deletes the row: a failed commit may leave an
    // unused archive, never a missing handoff.
    this.queue.setMeta(archiveKey, JSON.stringify({ task, reason, source, parts,
      ownerContext: JSON.stringify([this.queue.getMeta('goal'), this.queue.testingContext + this.queue.instructions]),
      events: this.queue.events(task.id, -1), archivedAt: Date.now() }));
    let count = 0;
    try {
      count = this.queue.splitTask(task.id, replacements);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (error?.invalidDecomposition) {
        this.rebuildFromRoot(this.queue.get(task.id) ?? task, `${reason} ${message}`);
        return false;
      }
      // The plan stays saved on the job, so the next tick commits it without replanning.
      this.queue.log(task.id, 'supervisor', 'split-commit-failed', message);
      this.log(`task ${task.seq}: the split could not be committed (${message}); retrying next tick`);
      return false;
    }
    if (count !== replacements.length) return false;
    this.queue.setMeta(decompositionKey(task), '');
    this.queue.log(task.id, 'supervisor', 'split-committed', `${source}: replaced by ${count} smaller tasks (${archiveKey})`);
    this.queue.log(null, 'supervisor', 'scope-split', `${archiveKey}: task ${task.seq} replaced by ${count} smaller tasks from ${source}`);
    const active = this.queue.activeTask();
    if (active && active.seq > task.seq) this.abandonExecution();
    this.reviewed.delete(task.id);
    this.log(`task ${task.seq} split into ${count} smaller tasks (${source}); the original was deleted`);
    this.changed();
    this.wakeAfterHandoff();
    return true;
  }

  /**
   * For a family whose splits never produce a verified result: undo the narrowing
   * and start over from the original task, on a fresh family and split allowance.
   * Every write here is one tasks_decomposition_update accepts: the row either
   * stays waiting for its split, or goes back to the executor through
   * executor_recovery. Any other patch is silently reverted by that trigger.
   *
   * Two rebuilds that fail the same way mean no division this host produces
   * converges on the job, so the executor then works on the original task
   * directly instead of multiplying tasks further.
   */
  protected rebuildFromRoot(task: Task, reason: string): void {
    const ancestry = decompositionAncestry(this.queue, task);
    const root = ancestry.length ? ancestry[ancestry.length - 1] : task;
    // Keyed by the restored content, not root.id/createdAt: once this rebuild
    // commits, the row carrying that content is this task's own id, so a
    // second exhaustion would walk its ancestry back only to itself and read
    // as a brand-new root under an id-keyed counter — never reaching the cap.
    const rebuildKey = `decompositionRebuilds:v1:${decompositionDigest([root.title, root.description,
      root.solutionVerifyPrompt])}`;
    let rebuilds = 0;
    try { rebuilds = Math.max(0, Math.floor(JSON.parse(this.queue.getMeta(rebuildKey) || '0'))); } catch { rebuilds = 0; }
    const original = { title: root.title, description: root.description,
      solutionVerifyPrompt: root.solutionVerifyPrompt, region: '', splitScope: '', finishedAt: null };
    if (rebuilds >= 2) {
      if (!this.stopForDecision(task, { ...original, status: 'PENDING', activityPhase: 'executor_recovery',
        activityDetail: reason.slice(0, 4000),
        supervisorFeedback: `${reason} Splitting did not converge after two rebuilds of the original task, ` +
          'so the executor now works on the original task directly.' })) return;
      this.queue.setMeta(decompositionKey(task), '');
      this.queue.log(task.id, 'supervisor', 'decomposition-rebuild-exhausted', reason);
      this.log(`task ${task.seq}: splitting did not converge after two rebuilds; the executor continues with the original task`);
    } else {
      if (!this.stopForDecision(task, { ...original, status: 'VERIFYING', activityPhase: 'decomposition_required',
        activityDetail: `${reason} Restored the original task (rebuild ${rebuilds + 1} of 2) to split it afresh.`.slice(0, 4000),
      })) return;
      this.queue.setMeta(rebuildKey, JSON.stringify(rebuilds + 1));
      this.queue.setMeta(decompositionKey(task), '');
      this.queue.log(task.id, 'supervisor', 'decomposition-rebuilt',
        JSON.stringify({ restoredFrom: root.id, rebuilds: rebuilds + 1, reason }));
      this.log(`task ${task.seq}: its family never produced a verified result; restored the original task to split afresh (rebuild ${rebuilds + 1} of 2)`);
    }
    this.pruneAbandonedLineage(task, [task, ...ancestry]);
    this.changed();
    this.wakeAfterHandoff();
  }

  /**
   * Deletes every task still in the list that this abandoned lineage produced
   * along the way — every sibling from every split point between the task
   * being restored and the root, at every generation. Each spawned row stamps
   * its own `region.scopeSplit.archiveKey`, so the abandoned set is exactly the
   * live rows whose archiveKey names one of those splits — never a task any
   * other split produced, and never one already VERIFIED.
   */
  protected pruneAbandonedLineage(kept: Task, lineage: Task[]): void {
    const archiveKeys = new Set<string>();
    for (const node of lineage) {
      try {
        const key = JSON.parse(node.region || '{}').scopeSplit?.archiveKey;
        if (key) archiveKeys.add(key);
      } catch { /* no split archive to trace */ }
    }
    if (!archiveKeys.size) return;
    let pruned = 0;
    for (const row of this.queue.list()) {
      if (row.id === kept.id || row.status === 'VERIFIED') continue;
      let key: unknown;
      try { key = JSON.parse(row.region || '{}').scopeSplit?.archiveKey; } catch { continue; }
      if (typeof key !== 'string' || !archiveKeys.has(key)) continue;
      this.queue.log(row.id, 'supervisor', 'decomposition-lineage-pruned',
        `Superseded by rebuilding task ${kept.seq} from its original scope; this task's own split strategy was abandoned.`);
      this.queue.remove(row.id);
      pruned++;
    }
    if (pruned) this.log(`task ${kept.seq}: removed ${pruned} leftover task(s) from the abandoned split lineage`);
  }

  /** The terminal exit for a run-wide condition no replacement can fix. */
  protected blockForHuman(snapshot: Task, reason: string): void {
    this.blockTask(snapshot, reason);
  }
}
