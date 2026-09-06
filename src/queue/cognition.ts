import { createHash } from 'crypto';
import type { Task } from './db';

/** Model selection and cognitive identity are separate: a verifier uses the executor model. */
export type CognitiveObserver = 'executor' | 'verifier' | 'supervisor' | 'planner';

export interface CognitiveBinding {
  workId: string;
  observer: CognitiveObserver;
}

export interface CognitiveSnapshot {
  workId: string;
  /** Core fallbacks also observe unbound chats and explicit tools/invoke requests. */
  observer: CognitiveObserver | 'coder' | 'user';
  version: number;
  seq: number;
  epoch: number;
  focus: Array<{ rule: string; priority: number; action?: string; evidence: number[]; detail: string }>;
  omitted: number;
  summary: string;
}

/** Stable across process restarts and rewritten attempts, separate for replacement tasks. */
export function taskCognition(
  task: Pick<Task, 'id' | 'createdAt'>,
  goal: string,
  observer: CognitiveObserver,
): CognitiveBinding {
  const digest = createHash('sha256').update(JSON.stringify([goal, task.id, task.createdAt])).digest('hex');
  return { workId: `task:${digest}`, observer };
}

/**
 * Only runtime observations enter the journal. Bound fields before serialization;
 * truncating JSON afterward would destroy evidence references and provenance.
 * These observations describe execution, not proof that the task is complete.
 */
export function cognitionRecord(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const envelope = params as Record<string, unknown>;
  const raw = (envelope.snapshot ?? envelope) as Partial<CognitiveSnapshot>;
  if (!raw || typeof raw !== 'object' || typeof raw.workId !== 'string' ||
      !['executor', 'verifier', 'supervisor', 'planner', 'coder', 'user'].includes(String(raw.observer)) ||
      !Number.isSafeInteger(raw.version) || !Number.isSafeInteger(raw.seq) ||
      !Number.isSafeInteger(raw.epoch) || !Array.isArray(raw.focus)) return undefined;
  const focus = raw.focus.slice(0, 6).flatMap(item => {
    if (!item || typeof item.rule !== 'string' || typeof item.detail !== 'string' ||
        !Number.isFinite(item.priority) || !Array.isArray(item.evidence)) return [];
    return [{
      rule: item.rule.slice(0, 100),
      priority: item.priority,
      ...(typeof item.action === 'string' ? { action: item.action.slice(0, 160) } : {}),
      evidence: item.evidence.filter(id => Number.isSafeInteger(id) && id >= 0).slice(0, 12),
      detail: item.detail.slice(0, 200),
    }];
  });
  return JSON.stringify({
    version: raw.version,
    workId: raw.workId.slice(0, 160),
    observer: raw.observer,
    seq: raw.seq,
    epoch: raw.epoch,
    summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 1000) : '',
    focus,
    omitted: (Number.isSafeInteger(raw.omitted) && raw.omitted! >= 0 ? raw.omitted! : 0) +
      raw.focus.length - focus.length,
  });
}
