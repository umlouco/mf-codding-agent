import * as vscode from 'vscode';
import type { ActivityRecord } from './agents';
import type { TaskQueue } from './db';
import { cognitionRecord } from './cognition';

/**
 * Writes one agent's stream into the `agent_logs` table as it happens.
 *
 * This is the feed behind the per-task terminals in the Task Queue view:
 * the text and reasoning an agent produces, every tool it calls and what came
 * back, and the activity records it writes while it waits. The view polls the
 * table every 200 ms (see queue/panel.ts), so nothing here talks to the
 * webview — the database is the broker, and a terminal opened after the
 * fact, or in another window on the same workspace, reads the same rows.
 *
 * Text is coalesced for a short interval before it is written. A row per
 * token would be tens of inserts a second for nothing: the reader is a person
 * and a 150 ms delay is invisible, while a row every 150 ms is what keeps the
 * table small enough to prune cheaply. Tool calls and activity are written
 * the moment they happen, since each is a line of its own.
 *
 * Distinct from the journal the orchestrator keeps in `task_events`, which
 * is what the supervisor reads: that one is coarser, kept for the life of the
 * task, and deliberately excludes the supervisor's own reasoning — feeding a
 * reviewer its previous review is how it learns to agree with itself. This
 * stream carries everyone, including the supervisor, and is pruned.
 */
export class LiveLog {
  private kind = '';
  private buffer = '';
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private lastActivity = '';
  private lastCognition = '';
  private readonly toolNames = new Map<string, string>();
  private readonly keep: number;

  constructor(
    private readonly queue: TaskQueue,
    private readonly taskId: number | null,
    private readonly actor: string,
  ) {
    this.keep = Math.max(
      200,
      vscode.workspace.getConfiguration('mfagent').get<number>('queue.liveLogKeep', 2000),
    );
  }

  /** Bound, so it can be handed straight to `RunOptions.onEvent`. */
  readonly onEvent = (method: string, params: any): void => {
    if (this.closed) {
      return;
    }
    if (method === 'agent/cognition') {
      const record = cognitionRecord(params);
      if (record && record !== this.lastCognition) {
        this.lastCognition = record;
        this.flush();
        this.write('cognition', record);
      }
      return;
    }
    if (method === 'stream/text' || method === 'stream/thinking') {
      const next = method === 'stream/thinking' ? 'reasoning' : 'response';
      if (this.kind && this.kind !== next) {
        this.flush();
      }
      this.kind = next;
      this.buffer += String(params?.delta ?? '');
      if (this.buffer.length >= 2000) {
        this.flush();
      } else {
        this.schedule();
      }
      return;
    }
    if (method !== 'stream/tool' || !params?.id) {
      return;
    }
    const id = String(params.id);
    const name = String(params.name || this.toolNames.get(id) || 'tool');
    switch (params.status) {
      case 'start':
        // The model announced the call; the core reports it again as
        // 'running' with a summary, which is the one worth a line.
        this.toolNames.set(id, name);
        return;
      case 'running': {
        this.flush();
        this.toolNames.set(id, name);
        const what = String(params.summary ?? '').trim() || brief(params.input);
        this.write('tool', `→ ${name}${what ? ` · ${what}` : ''}`);
        return;
      }
      default: {
        this.flush();
        this.toolNames.delete(id);
        const status = String(params.status ?? 'done');
        const elapsed = typeof params.elapsedMs === 'number' ? ` in ${fmtMs(params.elapsedMs)}` : '';
        const out = brief(params.output, 1500);
        this.write(status === 'error' ? 'tool-error' : 'tool', `← ${name} ${status}${elapsed}${out ? `\n${out}` : ''}`);
        return;
      }
    }
  };

  /** An activity record — the heartbeat — as a line, skipping exact repeats. */
  activity(a: ActivityRecord): void {
    if (this.closed) {
      return;
    }
    const line = `${a.phase}${a.detail ? ` — ${a.detail}` : ''}`;
    if (line === this.lastActivity) {
      return;
    }
    this.lastActivity = line;
    this.write('activity', line);
  }

  /** A marker from the orchestrator itself: an attempt starting, a stop. */
  note(kind: string, text: string): void {
    if (!this.closed) {
      this.flush();
      this.write(kind, text);
    }
  }

  /** Writes whatever text is buffered. Safe to call at any time. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.trim()) {
      this.write(this.kind || 'response', this.buffer);
    }
    this.buffer = '';
  }

  /** Flushes and stops accepting events — the turn is over. */
  close(): void {
    this.flush();
    this.closed = true;
  }

  private schedule(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 150);
    }
  }

  private write(kind: string, chunk: string): void {
    try {
      this.queue.appendLog(this.taskId, this.actor, kind, chunk, this.keep);
    } catch {
      // The database is closed or busy — the view goes without this line;
      // the turn itself must not.
    }
  }
}

/** A value as one short line, for a tool's input or output. */
function brief(value: unknown, max = 300): string {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
