import type * as vscode from 'vscode';
import { extractJson, runOnce } from './agents';
import { taskCognition } from './cognition';
import type { Task, TaskQueue } from './db';
import { LiveLog } from './liveLog';
import { ScopeEvidence } from './scopeEvidence';
import { parseScopeAssessment, ScopeAssessment, ScopeRole } from './scopePlan';
import { scopePrompt } from './scopePrompt';

export interface ScopeHost {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  queue: TaskQueue;
  task: Task;
  role: ScopeRole;
  current: () => boolean;
  intervalMs: number;
  split: (assessment: ScopeAssessment, snapshot: Task) => boolean;
  preflightActivity: (phase: string, detail: string, at: number) => void;
}

/** An independent scope lane: a long verifier must not occupy its own supervisor. */
export class ScopeSupervisor {
  private evidence = new ScopeEvidence();
  private closed = false;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private abort?: () => void;
  private lastReview = 0;
  private reviewedRevision = 0;
  private breadthReviewed = false;
  constructor(private host: ScopeHost) {}

  private current(): boolean {
    return !this.closed && this.host.current() && this.host.queue.runState === 'RUNNING';
  }

  async preflight(): Promise<boolean> {
    const keep = await this.assess('preflight');
    if (keep && this.current()) {
      this.timer = setInterval(() => { void this.check(); }, 5000);
      this.timer.unref?.();
    }
    return keep && this.current();
  }

  observe(method: string, params: any): void {
    if (this.current()) this.evidence.observe(method, params);
  }

  async check(): Promise<void> {
    if (!this.current()) { this.close(); return; }
    if (this.busy || this.evidence.revision <= this.reviewedRevision) return;
    // First widening gets an early look; subsequent looks need fresh evidence AND
    // the normal review interval. None of these counts chooses KEEP or SPLIT.
    const interval = this.evidence.breadthSignal && !this.breadthReviewed ? 30_000 : this.host.intervalMs;
    if (Date.now() - this.lastReview < interval) return;
    try { await this.assess('live'); } catch (error: any) {
      if (this.current()) this.host.queue.log(this.host.task.id, 'supervisor', 'scope-error',
        `${error?.message ?? error}; current work preserved, retry after fresh evidence.`);
    }
  }

  private async assess(stage: 'preflight' | 'live'): Promise<boolean> {
    if (!this.current() || this.busy) return false;
    this.busy = true;
    this.lastReview = Date.now();
    this.reviewedRevision = this.evidence.revision;
    this.breadthReviewed ||= this.evidence.breadthSignal;
    const { queue, task, role } = this.host;
    const snapshot = queue.get(task.id)!;
    const ownerContext = JSON.stringify([queue.getMeta('goal'), queue.contextInstructions]);
    const live = new LiveLog(queue, task.id, 'supervisor');
    const evidence = this.evidence.snapshot();
    const prompt = scopePrompt(snapshot, role, stage, queue.getMeta('goal'), queue.contextInstructions,
      evidence, queue.events(task.id, 40, true).filter(e => e.actor !== 'supervisor').reverse().map(e => ({ actor: e.actor, kind: e.kind,
        message: e.message.slice(0, 1600) })),
      queue.list().filter(t => t.id !== task.id && t.seq >= snapshot.seq).slice(0, 20)
        .map(t => ({ seq: t.seq, title: t.title, status: t.status })));
    try {
      let decision: ScopeAssessment | undefined;
      let repair = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runOnce(this.host.context, this.host.output, 'supervisor', prompt + repair, {
          cognition: taskCognition(task, queue.getMeta('goal'), 'supervisor'),
          onAbort: abort => { if (!this.current()) abort(); else this.abort = abort; },
          onEvent: (method, params) => { if (this.current()) live.onEvent(method, params); },
          onActivity: a => {
            if (!this.current()) return;
            live.activity(a);
            if (stage === 'preflight') this.host.preflightActivity('scope_review', a.detail, a.at);
          },
        });
        if (!this.current()) return false;
        queue.addUsage(task.id, result.usage);
        try {
          decision = parseScopeAssessment(extractJson(result.text, v => !!v && typeof v === 'object' &&
            ['KEEP', 'SPLIT'].includes((v as any).action)), snapshot);
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
      if (!latest || (['description', 'implVerifyPrompt', 'solutionVerifyPrompt', 'solutionVerifyCommand'] as const)
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
    if (this.timer) clearInterval(this.timer);
    try { this.abort?.(); } catch { /* Already stopped. */ }
    this.abort = undefined;
  }
}
