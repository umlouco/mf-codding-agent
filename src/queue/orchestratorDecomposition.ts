import type { Task } from './db';
import type { SupervisorDecision } from './agents';
import type { Review } from './orchestratorState';
import { OrchestratorRecovery } from './orchestratorRecovery';
import { bootstrapTddProblem, decideFailureDecomposition } from './failureDecomposition';
import { LiveLog } from './liveLog';
import { completeRecoveryJob, scheduleRecoveryJob } from './recoverySchedule';
import { decisionEvidence, providerUnavailable } from './recovery';
import { plannerIdentity } from './agents';
import { requiresPlaywright } from './playwrightPolicy';
import { admitDecomposition, decompositionAncestry, decompositionDigest, decompositionKey,
  decompositionRetryRevision, decompositionWorkspaceRevision, deferDecomposition, readDecomposition,
  requiresDecomposition, saveDecomposition, scheduleDecomposition, verificationStallStreak } from './recoveryDecomposition';

// Changing this is a host-strategy change, not new workspace evidence. It
// grants one newly bounded replacement-planning lane after a deployed parser
// or prompt repair, while preserving all prior rejected plans and their spend.
// v5 also snapshots the repaired current verification contract. Earlier
// planners could be in flight while an operator removed a malformed saved
// command; their reply then echoed the superseded command and was correctly
// rejected.  Let the repaired, current contract receive one bounded plan.
// v6 fixes the fingerprint itself: it used to include the same fine-grained
// workspace revision that the post-call staleness check compares against, so
// any incidental file touch during a long planning call both discarded the
// finished plan AND looked like a brand-new input, silently renewing the
// spent allowance every time. A task already parked as awaitingChange under
// an older fingerprint is unblocked once by this bump and re-enters under the
// now-correctly-enforced 3-attempt cap; see decompositionRetryRevision.
// v7 is a prompt/parser repair: replacements must now state targets (the
// files each one edits) and the host rejects any replacement over 3 files,
// forcing an oversized "fix every occurrence across the codebase" task to be
// partitioned by file population at plan time instead of only being
// discovered as too large after it has already failed for hours.
// v8 fixes decomposition being requested at all over a transport/provider
// outage: a verifier or supervisor call that never reached the model (a DNS
// failure, a dead connection, a provider quota refusal) used to count
// identically to the model actually looking at the task and failing to
// verify it — see providerUnavailable. Two such outages 13 seconds apart were
// enough to retire a perfectly reasonable task and start narrowing it into
// smaller and smaller replacements, entirely because the network, not the
// task, was the problem. Bumping the strategy also gives any task already
// parked under the old blind fingerprint one bounded fresh look under the
// fixed logic.
const DECOMPOSITION_STRATEGY = 'failure-decomposition-v8';

/** A different planner can repair a rejected proposal; credentials and clock time cannot. */
export function decompositionPlannerIdentity(): string {
  return decompositionDigest(plannerIdentity?.() || []);
}

/** A rejected/exhausted task has only one exit: commit its complete replacement and retire its row. */
export abstract class OrchestratorDecomposition extends OrchestratorRecovery {
  protected abstract applyVerdictSplit(task: Task, decision: SupervisorDecision, current: () => boolean): boolean;

  protected requireBootstrapRepair(task: Task): boolean {
    if (task.seq !== 1 || task.kind === 'phase' || !requiresPlaywright(this.queue)) return false;
    const problem = bootstrapTddProblem(task.description);
    if (!problem) return false;
    this.requestFailureDecomposition(task, problem);
    return true;
  }

  protected requestFailureDecomposition(snapshot: Task, reason: string): void {
    const task = this.queue.get(snapshot.id);
    if (!task || task.status === 'VERIFIED' || this.disposed || this.queue.runState !== 'RUNNING') return;
    const existing = readDecomposition(this.queue, task);
    if (!this.stopForDecision(task, { status: 'VERIFYING', finishedAt: null,
      activityPhase: 'decomposition_required', activityDetail: reason.slice(0, 4000) })) return;
    // Fence this task's callback without releasing the cycle into a concurrent provider call.
    if (this.review?.taskId === task.id) {
      const old = this.review;
      this.review = null; this.reviewGen++;
      try { old.abort?.(); } catch { /* The completed/rejected turn may already be gone. */ }
    }
    scheduleDecomposition(this.queue, task, reason);
    completeRecoveryJob(this.queue, task);
    if (!existing) this.log(`task ${task.seq}: supervisor must replace this task with smaller work: ${reason}`);
    this.changed();
    if (!existing) this.wakeAfterHandoff();
  }

  /**
   * A bounded replan allowance exists to stop narrowing from running forever,
   * not to hand the run to a person. This queue never stops for one — see
   * requestFailureDecomposition and splitTask — so exhausting that allowance
   * without a verified outcome has to lead somewhere autonomous too: undo the
   * narrowing and try the complete original job again, exactly as if a person
   * had rewritten the run back to it. That is a structurally different move
   * from "split narrower once more," so it earns its own fresh lineage rather
   * than reusing the exhausted one.
   *
   * A second full rebuild-and-resplit cycle failing the same way means no
   * phrasing this host can produce converges on this job; a third rebuild
   * would only repeat that cycle, so it hands off to ordinary autonomous
   * recovery instead (bounded backoff, retried indefinitely, still no human
   * step) rather than rebuilding again.
   */
  protected rebuildFromRoot(task: Task, reason: string): void {
    const ancestry = decompositionAncestry(this.queue, task);
    const root = ancestry.length ? ancestry[ancestry.length - 1] : task;
    // Keyed by the restored content, not root.id/createdAt: once this rebuild
    // commits, the row carrying that content is this task's own id, so a
    // second exhaustion would walk its ancestry back only to itself and read
    // as a brand-new root under an id-keyed counter — never reaching the cap.
    // The content is what actually stays invariant across rebuild cycles.
    const rebuildKey = `decompositionRebuilds:v1:${decompositionDigest([root.title, root.description,
      root.implVerifyPrompt, root.solutionVerifyPrompt, root.solutionVerifyCommand])}`;
    let rebuilds = 0;
    try { rebuilds = Math.max(0, Math.floor(JSON.parse(this.queue.getMeta(rebuildKey) || '0'))); } catch { rebuilds = 0; }
    this.queue.setMeta(decompositionKey(task), '');
    if (rebuilds >= 2) {
      if (!this.stopForDecision(task, { activityPhase: 'recovery_execution', activityDetail: reason.slice(0, 4000) })) return;
      const job = scheduleRecoveryJob(this.queue, task, `${reason} Two full rebuilds of the original task did not ` +
        'converge either; continuing as ordinary autonomous recovery instead of narrowing further.');
      this.queue.recordActivity(task.id, 'recovery_waiting',
        `${job.reason} Autonomous recovery is scheduled for ${new Date(job.dueAt).toISOString()}.`, 'supervisor');
      this.queue.log(task.id, 'supervisor', 'decomposition-rebuild-exhausted', reason);
      this.log(`task ${task.seq}: repeated narrowing and two full rebuilds did not converge; handed to ordinary recovery`);
      this.changed();
      this.wakeAfterHandoff();
      return;
    }
    this.queue.setMeta(rebuildKey, JSON.stringify(rebuilds + 1));
    if (!this.stopForDecision(task, {
      title: root.title, description: root.description, implVerifyPrompt: root.implVerifyPrompt,
      solutionVerifyPrompt: root.solutionVerifyPrompt, solutionVerifyCommand: root.solutionVerifyCommand,
      status: 'PENDING', attempts: 0, finishedAt: null, output: '', errorLog: '', validationReport: '',
      splitScope: '', activityPhase: '', activityDetail: '', region: '',
      supervisorFeedback: `${reason} Repeated narrowing produced no verified outcome; restored the original ` +
        `task (rebuild ${rebuilds + 1} of 2) instead of splitting it again.`,
    })) return;
    this.queue.log(task.id, 'supervisor', 'decomposition-rebuilt',
      JSON.stringify({ restoredFrom: root.id, rebuilds: rebuilds + 1, reason }));
    this.log(`task ${task.seq}: repeated narrowing did not converge; restored the original task (rebuild ${rebuilds + 1} of 2)`);
    this.pruneAbandonedLineage(task, [task, ...ancestry]);
    this.changed();
    this.wakeAfterHandoff();
  }

  /**
   * Deletes every task still in the list that this abandoned lineage produced
   * along the way — every sibling from every split point between the task
   * being restored and the root, at every generation. rebuildFromRoot's whole
   * premise is that this narrowing strategy failed and the *entire* original
   * scope is being redone from the goal; every task those splits produced
   * belongs to a plan just declared a dead end, and now duplicates whatever
   * the restored task will cover again from scratch, so it never gets a
   * "real" answer of its own — it only ever sat at zero attempts waiting for
   * a lockstep queue to reach it, and no rebuild before this one ever swept it
   * away. `applyVerdictSplit` stamps every child's `region.scopeSplit.archiveKey`
   * with the exact archive record its own split produced, so every task the
   * whole abandoned lineage generated is exactly the set of live rows whose
   * own archiveKey names one of those splits — never a task any OTHER split
   * produced, and never one already VERIFIED.
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

  protected decompositionWorkspaceRevision(): string {
    return decompositionWorkspaceRevision(this.workspaceRoot);
  }

  /** See decompositionRetryRevision: deliberately coarser than the check above. */
  protected decompositionRetryRevision(): string {
    return decompositionRetryRevision(this.workspaceRoot);
  }

  protected async serviceFailureDecomposition(snapshot: Task): Promise<boolean> {
    let task = this.queue.get(snapshot.id);
    if (!task || !requiresDecomposition(task)) return false;
    if (this.disposed || this.queue.runState !== 'RUNNING') return true;
    if (!readDecomposition(this.queue, task)) this.requestFailureDecomposition(task,
      task.activityDetail || task.supervisorFeedback || task.errorLog || 'Legacy failed task requires replacement.');
    task = this.queue.get(task.id)!;
    const job = readDecomposition(this.queue, task)!;
    const owner = () => JSON.stringify([this.queue.getMeta('goal'), this.queue.contextInstructions,
      this.queue.testingContext, this.queue.instructions]);
    const ownerAtStart = owner();
    // workspace guards staleness (below, after the provider call); retryRevision seeds the
    // admission fingerprint. They must stay different signals — see decompositionRetryRevision.
    const workspace = this.decompositionWorkspaceRevision();
    const retryRevision = this.decompositionRetryRevision();
    const evidence = decisionEvidence(this.queue, task);
    const contract = (row: Task) => JSON.stringify([row.createdAt, row.startedAt, row.attempts, row.title,
      row.description, row.implVerifyPrompt, row.solutionVerifyPrompt, row.solutionVerifyCommand,
      row.region, row.splitScope, row.output, row.validationReport]);
    const contractAtStart = contract(task);
    const planner = decompositionPlannerIdentity();
    const fingerprint = decompositionDigest([DECOMPOSITION_STRATEGY, planner, ownerAtStart, contractAtStart, retryRevision, evidence]);
    if (!admitDecomposition(this.queue, task, job, fingerprint)) {
      // A crash on the last admitted call must not leave a row claiming to be planning forever.
      if ((job.inputs[fingerprint] ?? 0) >= 3 && task.activityPhase !== 'decomposition_waiting') {
        this.rebuildFromRoot(task, 'Decomposition allowance exhausted for unchanged input.');
      }
      return true;
    }
    // Splitting narrower cannot fix a verifier that cannot converge on the current
    // shape of the task — see verificationStallStreak. Three such splits in a row
    // in this family, with no defect and no verified proof ever produced, means
    // narrowing itself is the failure mode; stop feeding it and rebuild instead,
    // the same escalation the general split/attempt ceilings use elsewhere.
    const stallStreak = verificationStallStreak(this.queue, task, job.reason);
    if (stallStreak >= 3) {
      this.rebuildFromRoot(task, 'Verification failed to converge for three consecutive replacements in ' +
        'this family with no implementation defect ever observed and no verified proof produced; narrowing ' +
        `the verification further will not help. ${job.reason}`);
      return true;
    }
    const review: Review = { taskId: task.id, seq: task.seq, gen: ++this.reviewGen,
      lastActivityAt: Date.now(), startedAt: Date.now(), lastModelOutputAt: Date.now() };
    this.review = review;
    const accepts = () => {
      const current = this.queue.get(task!.id);
      return !this.disposed && this.queue.runState === 'RUNNING' && this.reviewGen === review.gen &&
        !!current && current.status === 'VERIFYING' && requiresDecomposition(current) &&
        contract(current) === contractAtStart && owner() === ownerAtStart &&
        decompositionPlannerIdentity() === planner &&
        decisionEvidence(this.queue, current) <= evidence;
    };
    this.queue.recordActivity(task.id, 'decomposition_planning',
      'Supervisor is replacing the rejected task; the original cannot execute again.', 'supervisor');
    const live = new LiveLog(this.queue, task.id, 'supervisor');
    const onEvent = this.observerEvents(task.id, 'supervisor', live, accepts);
    this.changed();
    try {
      const decision = await decideFailureDecomposition(this.context, this.output, task, {
        goal: this.queue.getMeta('goal'),
        requireRunnableSuite: task.seq === 1 && requiresPlaywright(this.queue),
        ownerInstructions: this.queue.contextInstructions + '\n' + this.queue.testingContext + this.queue.instructions,
        evidence: JSON.stringify({ reason: job.reason, errorLog: task.errorLog, report: task.validationReport.slice(0, 16000),
          events: this.queue.events(task.id, 16, true).map(event => ({ actor: event.actor, kind: event.kind, message: event.message.slice(0, 1500) })),
          remainingQueue: this.queue.list().filter(row => row.id !== task!.id)
            .map(row => ({ title: row.title, status: row.status })) }),
        handoff: task.output.slice(0, 8000), ancestry: decompositionAncestry(this.queue, task).map(parent => ({
          title: parent.title, description: parent.description, implVerifyPrompt: parent.implVerifyPrompt,
          solutionVerifyPrompt: parent.solutionVerifyPrompt, solutionVerifyCommand: parent.solutionVerifyCommand })),
        previousInvalidPlan: job.invalidPlan, previousError: job.lastError,
        verificationStallStreak: stallStreak,
      }, {
        onAbort: abort => { if (!accepts()) abort(); else review.abort = abort; },
        onEvent: (method, params) => {
          if (!accepts()) return;
          if ((method === 'stream/text' || method === 'stream/thinking') &&
              typeof params?.delta === 'string' && params.delta.trim()) {
            review.lastModelOutputAt = review.lastActivityAt = Date.now();
          }
          onEvent(method, params);
        },
        onActivity: activity => {
          if (!accepts()) return;
          review.lastActivityAt = Date.now();
          live.activity(activity);
          // Preserve the recovery phase while exposing which provider/stage is
          // actually waiting. A heartbeat is visibility, not forward progress.
          if (this.queue.recordActivity(task!.id, 'decomposition_planning',
            `${activity.phase}: ${activity.detail || 'Replacement planner is active.'}`, 'supervisor')) this.changed();
        },
      });
      if (!accepts()) return true;
      this.queue.addUsage(task.id, decision.usage);
      if (this.decompositionWorkspaceRevision() !== workspace) throw Error('Workspace changed while replacement was planned; reassess current work.');
      if (!this.applyVerdictSplit(this.queue.get(task.id)!, decision, accepts)) {
        throw Error('Replacement was superseded before commit; no parent was deleted.');
      }
    } catch (error: any) {
      if (!accepts()) return true;
      if (error?.usage) this.queue.addUsage(task.id, error.usage);
      const message = String(error?.message ?? error);
      const wasInvalid = error?.invalidDecomposition === true || typeof error?.invalidPlan === 'string';
      if (providerUnavailable(message) && !wasInvalid) {
        // The replacement planner was never reached — this attempt proves
        // nothing about the task or the input, so it must not spend the
        // bounded per-input replan allowance admitDecomposition already
        // reserved for it before dispatch (see admitDecomposition's own
        // comment on why that reservation happens early). Refund it and let
        // the existing backoff (already set on the job's dueAt) retry later.
        job.inputs[fingerprint] = Math.max(0, (job.inputs[fingerprint] ?? 1) - 1);
        saveDecomposition(this.queue, task, job);
        this.queue.recordActivity(task.id, 'decomposition_planning',
          `Replacement planner could not reach the provider: ${message}. Retrying automatically once it answers; this is not evidence about the task.`, 'supervisor');
        this.log(`task ${task.seq}: replacement planner unreachable, not counted against it: ${message}`);
        this.changed();
        return true;
      }
      job.invalidPlan = typeof error?.invalidPlan === 'string' ? error.invalidPlan : job.invalidPlan;
      const next = deferDecomposition(this.queue, task, job, message, wasInvalid);
      if (next.newlyBlocked) this.rebuildFromRoot(task, next.detail);
      this.log(`task ${task.seq}: replacement not committed; original evidence retained. ${next.detail}`);
    } finally {
      live.close();
      if (this.review === review) this.review = null;
      this.changed();
    }
    return true;
  }
}
