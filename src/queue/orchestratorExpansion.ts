import * as path from 'path';
import { encodeRegion, expandPhase, parseRegion, PhaseExpansion, Region, runScanCommand, withinRegion } from './agents';
import { NewTask, Task } from './db';
import { LiveLog } from './liveLog';
import { OrchestratorExecution } from './orchestratorExecution';
import { appendAttempt } from './orchestratorState';

export abstract class OrchestratorExpansion extends OrchestratorExecution {

  /**
   * Expands one phase into the tasks — or, occasionally, the smaller phases —
   * it should have been.
   *
   * Success replaces the phase atomically. Failure enters scheduled diagnosis,
   * not functional verification or an immediate unchanged expansion retry.
   */
  protected async runExpansion(task: Task, attempt: number, gen: number, current: () => boolean): Promise<void> {
    this.log(`expanding phase ${task.seq} — ${task.title} (attempt ${task.attempts})`);
    const goal = this.queue.getMeta('goal');
    const live = new LiveLog(this.queue, task.id, 'planner');
    const observe = this.observerEvents(task.id, 'planner', live);

    let result: PhaseExpansion;
    try {
      result = await expandPhase(
        this.context,
        this.output,
        task,
        goal,
        (a) => {
          if (!current()) return;
          live.activity(a);
          if (this.queue.recordActivity(task.id, a.phase, a.detail)) {
            this.changed();
          }
        },
        (method, params) => { if (current()) observe(method, params); },
        (abort) => {
          if (!current()) { abort(); return; }
          this.executionAbort = abort;
        },
        this.queue.contextInstructions,
      );
    } catch (e: any) {
      live.close();
      if (!current()) return;
      const msg = String(e?.message ?? e);
      this.deferPhaseRecovery(task, attempt, `the expansion agent stopped before reporting: ${msg}`);
      if (this.executionGen === gen) this.executionAbort = null;
      this.changed();
      return;
    }

    live.close();
    if (!current()) return;
    if (this.executionGen === gen) this.executionAbort = null;
    this.queue.addUsage(task.id, result.usage);

    // The expander itself may flag a slice of its own region as still too
    // broad once it has actually explored it — code, not the model, decides
    // how much smaller that slice really needs to be. See resplitPhaseRegion.
    const resolvedSplits: NewTask[] = [];
    for (const req of result.splitRequests) {
      const parts = await this.resplitPhaseRegion(
        task,
        req.path,
        req.title || task.title,
        req.description || task.description,
      );
      resolvedSplits.push(...parts);
    }

    let parts: NewTask[] = [...result.tasks, ...resolvedSplits];

    if (parts.length === 0 && result.cutOff) {
      // The round budget ran out before anything usable came back — a size
      // signal, not just "it failed" — so code tries to shrink the phase
      // itself rather than asking an identically-scoped retry to hit the
      // same wall again.
      parts = await this.resplitPhaseRegion(task, undefined, task.title, task.description);
    }

    if (!current()) return;
    if (parts.length > 0) {
      const applied = this.queue.expandTask(task.id, attempt, parts);
      if (applied > 0) {
        // expandTask already journals the committed replacement at queue level.
        // The phase ID is retired, so another task-scoped event would violate its foreign key.
        this.log(`phase ${task.seq} expanded into ${applied} row(s)`);
      } else {
        this.log(`phase ${task.seq} — result arrived after the run moved past this attempt; discarding it`);
      }
      this.changed();
      return;
    }

    // An empty plan is unfinished work, not permission to loop the same planner.
    const note = result.cutOff
      ? 'cut off before producing a usable task list, and the region could not be split any further'
      : 'produced no usable tasks';
    this.deferPhaseRecovery(task, attempt, note);
    this.changed();
  }

  private deferPhaseRecovery(task: Task, attempt: number, reason: string): void {
    const applied = this.queue.finishExecution(task.id, attempt, {
      status: 'VERIFYING', finishedAt: null,
      errorLog: appendAttempt(task.errorLog, `[attempt ${task.attempts}] ${reason}.`),
    });
    if (!applied) return;
    this.queue.log(task.id, 'planner', 'expansion-failed', reason);
    this.pauseForRecovery(this.queue.get(task.id)!, `Phase expansion needs a changed planning approach: ${reason}`);
    this.log(`phase ${task.seq}: ${reason}; autonomous recovery scheduled, phase retained`);
  }

  /**
   * Deterministically re-derives smaller regions for (part of) a phase's own
   * territory and turns each into a fresh phase row.
   *
   * Two callers, two shapes of the same idea. A phase that merged several
   * scanned regions un-merges back into one phase per region — always a real
   * reduction in scope, and no rescan is needed to know that. A phase over a
   * single region (or a sub-slice the expander itself named) gets that one
   * path rescanned at half the usual ceiling, which only produces more than
   * one region if there is real subdirectory structure to divide it by.
   * Either way, size comes from a fresh count of files, never from the
   * model's own say-so.
   */
  protected async resplitPhaseRegion(
    phase: Task,
    narrowToPath: string | undefined,
    title: string,
    description: string,
  ): Promise<NewTask[]> {
    const region = parseRegion(phase.region);
    const maxPerRegion = Math.max(1, this.cfg<number>('queue.maxFilesPerRegion', 150));

    if (!narrowToPath && region.paths.length > 1) {
      const parts: NewTask[] = [];
      for (const p of region.paths) {
        const fileCount = await this.regionFileCount(p, maxPerRegion);
        parts.push({
          title: `${title} — ${p}`,
          description,
          kind: 'phase',
          region: encodeRegion({ paths: [p], fileCount }),
        });
      }
      return parts;
    }

    const target = narrowToPath && withinRegion(narrowToPath, region.paths) ? narrowToPath : region.paths[0];
    if (!target) {
      return [];
    }

    const forced = Math.max(1, Math.ceil(maxPerRegion / 2));
    let sub: Region[];
    try {
      sub = await runScanCommand(this.context, path.join(this.workspaceRoot, target), forced);
    } catch (e: any) {
      this.log(`could not re-scan ${target} while splitting phase ${phase.seq}: ${e?.message ?? e}`);
      return [];
    }
    if (sub.length <= 1) {
      // No further directory structure to divide on — nothing more code can
      // try; the caller falls back to a plain retry.
      return [];
    }
    return sub.map((r) => {
      const joined = r.path === '.' ? target : `${target}/${r.path}`;
      return {
        title: `${title} — ${joined}`,
        description,
        kind: 'phase' as const,
        region: encodeRegion({ paths: [joined], fileCount: r.fileCount }),
      };
    });
  }

  /** The real file count behind one already-known region path, via a fresh scan. */
  protected async regionFileCount(relPath: string, ceiling: number): Promise<number> {
    try {
      const regions = await runScanCommand(this.context, path.join(this.workspaceRoot, relPath), ceiling);
      return regions.reduce((sum, r) => sum + r.fileCount, 0);
    } catch {
      return 0;
    }
  }
}
