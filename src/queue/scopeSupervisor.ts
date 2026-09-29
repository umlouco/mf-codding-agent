import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { extractJson, runOnce } from './agents';
import { taskCognition } from './cognition';
import type { Task, TaskQueue } from './db';
import { LiveLog } from './liveLog';
import { ScopeEvidence } from './scopeEvidence';
import { parseScopeAssessment, ScopeAssessment, ScopeRole } from './scopePlan';
import { scopePrompt } from './scopePrompt';
import { discoverWork, indexRepository, WorkInventory } from './workInventory';
import { inventoryScopePlan, scopeBoundary } from './scopeBoundary';
import { readScopeRetry } from './scopeRetry';

/**
 * At or below this many files, the deterministic workspace scan already bounds
 * a task's scope, so a discovery model turn cannot reveal a population it would
 * have missed. Above it, discovery runs as before. Set 0 to always discover.
 */
/**
 * Whether the previous scope deferral was a discovery blocker rather than a
 * transport or contract fault.
 *
 * The signal is the recorded outcome kind, not the wording: discovery rephrases
 * the same missing prerequisite on every turn (observed: "Shape first: …" then
 * "Shape is settled and is not the blocker: …"), so comparing reason text let
 * the loop continue. A prior blocked deferral for the same fingerprint (see
 * readScopeRetry, which returns nothing once the contract or owner context
 * changes) means nothing discovery can see has changed.
 */
function blockedDeferral(reason: string): boolean {
  return /^Discovery needs evidence:/.test(reason.trim());
}

/**
 * Whether a discovery model turn runs before each task. Off by default: the
 * planner already sizes every task to one coder session, and a task that still
 * fails is split by the failure lane. The turn only delayed each start (and, on a
 * Claude CLI planner, cost an Opus-class request per task) without ever
 * changing what the executor was asked to do.
 */
function preflightEnabled(): boolean {
  return vscode.workspace.getConfiguration('mfagent').get<boolean>('queue.scopePreflight', false) === true;
}

function smallScopeFiles(): number {
  const configured = vscode.workspace.getConfiguration('mfagent').get<number>('queue.scopeDiscoveryMinFiles', 20);
  return Number.isFinite(configured) ? Math.max(0, configured) : 20;
}

export interface ScopeHost {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  queue: TaskQueue;
  task: Task;
  role: ScopeRole;
  current: () => boolean;
  split: (assessment: ScopeAssessment, snapshot: Task) => boolean;
  preflightActivity: (phase: string, detail: string, at: number) => void;
}

/** An independent scope lane: a long verifier must not occupy its own supervisor. */
export class ScopeSupervisor {
  private closed = false;
  private busy = false;
  private abort?: () => void;
  constructor(private host: ScopeHost) {}

  private current(): boolean {
    return !this.closed && this.host.current() && this.host.queue.runState === 'RUNNING';
  }

  /**
   * Pre-execution scope review.
   *
   * Runs exactly once, while the task is claimed but before the executor is
   * launched. It decomposes the task when the description contains more than
   * one independent task, more than one item to check, or more than one item
   * to create. The host commits any replacement plan atomically and deletes
   * the original row, so the executor that eventually starts owns one bounded
   * outcome.
   *
   * No live timer is started. This lane once kept reviewing a running worker
   * and split it mid-flight; in the ten-hour run that prompted this change it
   * produced 50 splits of a single read-only inspect task. Scope is a
   * launch-time decision again, so a worker that is already executing is never
   * re-multiplied. A KEEP assessment simply lets the executor proceed.
   */
  async preflight(): Promise<boolean> {
    const keep = await this.assess('preflight');
    return keep && this.current();
  }

  /**
   * Records a KEEP that was decided from recorded facts rather than a model
   * turn, so the audit trail still shows what authorized execution and why.
   */
  private keepDeterministically(stage: 'preflight', role: ScopeRole, snapshot: Task,
    reason: string, evidence?: unknown): boolean {
    this.host.queue.log(snapshot.id, 'supervisor', 'scope-assessment', JSON.stringify({
      stage, role, action: 'KEEP', reason, deterministic: true, ...(evidence === undefined ? {} : { evidence }),
    }));
    return true;
  }

  private async assess(stage: 'preflight'): Promise<boolean> {
    if (!this.current() || this.busy) return false;
    if (!preflightEnabled()) {
      const { queue, task, role } = this.host;
      return this.keepDeterministically(stage, role, queue.get(task.id) ?? task,
        'Pre-execution discovery is off (queue.scopePreflight); the planner sized this task and a failure splits it.');
    }
    this.busy = true;
    const { queue, task, role } = this.host;
    const snapshot = queue.get(task.id)!;
    const ownerContext = JSON.stringify([queue.getMeta('goal'), queue.contextInstructions]);
    const live = new LiveLog(queue, task.id, 'supervisor');
    // Preflight runs before the worker starts, so there is no execution evidence yet.
    const evidence = new ScopeEvidence().snapshot();
    const prompt = scopePrompt(snapshot, role, stage, queue.getMeta('goal'), queue.contextInstructions,
      evidence, queue.events(task.id, 40, true).filter(e => e.actor !== 'supervisor').reverse().map(e => ({ actor: e.actor, kind: e.kind,
        message: e.message.slice(0, 1600) })),
      queue.list().filter(t => t.id !== task.id && t.seq >= snapshot.seq).slice(0, 20)
        .map(t => ({ seq: t.seq, title: t.title, status: t.status }))) + `\n${scopeBoundary(snapshot)}`;
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      // Two deterministic KEEPs. The model turns below were the single largest
      // avoidable cost per task: on a small project every task paid a discovery
      // call and an assessment call before any code was written. Neither fact
      // can change what discovery would find, so neither needs a model.
      if (scopeBoundary(snapshot)) {
        return this.keepDeterministically(stage, role, snapshot,
          'Committed execution ticket; its scope is already bounded and changing it is forbidden.');
      }
      let inventory: WorkInventory | undefined;
      if (root) {
        const repository = indexRepository(root);
        if (repository.files.length <= smallScopeFiles()) {
          return this.keepDeterministically(stage, role, snapshot,
            `The workspace has ${repository.files.length} file(s); the deterministic region already bounds this task.`);
        }
        const key = 'workInventory:' + createHash('sha256').update(JSON.stringify([task.id, task.createdAt,
          snapshot.description, snapshot.solutionVerifyPrompt,
          ownerContext, repository.fingerprint])).digest('hex');
        const cached = queue.getMeta(key);
        let previousFailure = readScopeRetry(queue, snapshot)?.reason || '';
        if (cached) {
          try { inventory = JSON.parse(cached); } catch { /* Reassess invalid cache entries. */ }
          // Older builds cached blocked discoveries forever. They are claims
          // about missing evidence, not reusable admission decisions. Retain
          // the journal, but ask again, even when repository paths are unchanged.
          if (inventory?.strategy === 'blocked') {
            previousFailure ||= inventory.reason;
            inventory = undefined;
          }
          if (!inventory) queue.setMeta(key, '');
        }
        if (!inventory) {
          inventory = await discoverWork(snapshot, queue.getMeta('goal'), queue.contextInstructions, repository,
            async prompt => {
              const result = await runOnce(this.host.context, this.host.output, 'supervisor', prompt, {
                planningOnly: true,
                cognition: taskCognition(task, queue.getMeta('goal'), 'supervisor'),
                onAbort: abort => { if (!this.current()) abort(); else this.abort = abort; },
                onEvent: (method, params) => { if (this.current()) live.onEvent(method, params); },
                onActivity: a => {
                  if (!this.current()) return;
                  live.activity(a);
                  this.host.preflightActivity('scope_review', a.detail, a.at);
                },
              });
              if (!this.current()) throw Error('Discovery was superseded.');
              queue.addUsage(task.id, result.usage);
              return result.text;
            }, text => extractJson(text, v => !!v && typeof v === 'object' && 'strategy' in v), previousFailure);
          if (inventory.strategy !== 'blocked') queue.setMeta(key, JSON.stringify(inventory));
          queue.log(task.id, 'supervisor', 'work-inventory', JSON.stringify(inventory));
        }
        if (!this.current()) return false;
        const latest = queue.get(task.id);
        if (!latest || (['description', 'solutionVerifyPrompt'] as const)
          .some(field => latest[field] !== snapshot[field]) ||
          ownerContext !== JSON.stringify([queue.getMeta('goal'), queue.contextInstructions])) {
          throw Error('Contract changed during discovery; inventory cannot authorize work.');
        }
        if (!inventory) throw Error('Discovery returned no inventory.');
        if (inventory.strategy === 'blocked') {
          // The first blocker is deferred: evidence may still arrive (a missing
          // file written, an owner edit made), so ask again at the backoff
          // deadline. A second blocked result on the same fingerprint means
          // nothing discovery can see has changed. Re-planning only repeats the
          // missing prerequisite, and nobody is going to supply it: the queue
          // never waits on a person. Discovery's claim is an unverified risk,
          // not a scope finding, so the executor starts with the blocker on its
          // row and checks it with real tools. A prerequisite that is truly
          // absent fails that attempt with evidence, and the ordinary failure
          // lane replaces the task with smaller ones.
          const prior = readScopeRetry(queue, snapshot)?.reason || '';
          if (blockedDeferral(prior)) {
            const risk = `Scope discovery could not confirm this prerequisite and reported it twice: ${inventory.reason}\n` +
              'Treat it as an unverified risk, not a fact. Check it yourself with your tools; if it is really ' +
              'missing, create what you can (a fixture, another credential source) and otherwise report the ' +
              'blocker with the evidence you gathered instead of waiting for it.';
            queue.update(task.id, { supervisorFeedback: [snapshot.supervisorFeedback, risk].filter(Boolean).join('\n\n') });
            return this.keepDeterministically(stage, role, snapshot,
              'Discovery reported the same blocker twice; the executor confirms it instead of the run waiting.',
              { blocker: inventory.reason });
          }
          throw Error(`Discovery needs evidence: ${inventory.reason}`);
        }
        // "atomic" is already the host's definition of one independently
        // checkable outcome. A second model turn to confirm KEEP adds no
        // information, and every task was paying for it.
        if (inventory.strategy === 'atomic') {
          return this.keepDeterministically(stage, role, snapshot,
            `Discovery found one independently checkable outcome: ${inventory.reason}`, inventory);
        }
        if (inventory.strategy === 'enumerate') {
          if (indexRepository(root).fingerprint !== repository.fingerprint) throw Error('Repository membership changed during discovery; re-inventory before scheduling.');
          const decision = parseScopeAssessment(inventoryScopePlan(snapshot, inventory), snapshot, inventory);
          if (!this.host.split(decision, snapshot)) throw Error('Inventory-backed plan was superseded.');
          return false;
        }
      }
      let decision: ScopeAssessment | undefined;
      let repair = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runOnce(this.host.context, this.host.output, 'supervisor', prompt + repair, {
          planningOnly: true,
          cognition: taskCognition(task, queue.getMeta('goal'), 'supervisor'),
          onAbort: abort => { if (!this.current()) abort(); else this.abort = abort; },
          onEvent: (method, params) => { if (this.current()) live.onEvent(method, params); },
          onActivity: a => {
            if (!this.current()) return;
            live.activity(a);
            this.host.preflightActivity('scope_review', a.detail, a.at);
          },
        });
        if (!this.current()) return false;
        queue.addUsage(task.id, result.usage);
        try {
          decision = parseScopeAssessment(extractJson(result.text, v => !!v && typeof v === 'object' &&
            ['KEEP', 'SPLIT'].includes((v as any).action)), snapshot, inventory);
          break;
        } catch (error: any) {
          if (attempt) throw error;
          repair = `\nYour previous decision was rejected: ${error?.message ?? error}\n` +
            `Previous response:\n${result.text}\nReturn the complete corrected decision, not a partial patch.`;
        }
      }
      if (!decision || !this.current()) return false;
      if (ownerContext !== JSON.stringify([queue.getMeta('goal'), queue.contextInstructions])) {
        throw new Error('Owner requirements changed during scope review; obtain a fresh assessment.');
      }
      const latest = queue.get(task.id);
      if (!latest || (['description', 'solutionVerifyPrompt'] as const)
        .some(key => latest[key] !== snapshot[key])) {
        throw new Error('Task contract changed during scope review; obtain a fresh assessment.');
      }
      queue.log(task.id, 'supervisor', 'scope-assessment', JSON.stringify({ stage, role,
        action: decision.action, reason: decision.reason, execution: decision.execution,
        verification: decision.verification, evidence }));
      if (decision.action === 'SPLIT') {
        if (!this.host.split(decision, snapshot)) throw new Error('Scope split could not be applied; re-assess before starting work.');
        return false;
      }
      return true;
    } finally {
      this.abort = undefined;
      this.busy = false;
      live.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.abort?.(); } catch { /* Already stopped. */ }
    this.abort = undefined;
  }
}
