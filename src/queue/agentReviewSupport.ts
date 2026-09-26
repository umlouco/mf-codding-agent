import { Task, NewTask, Usage } from './db';

// ---- supervisor --------------------------------------------------------

/**
 * Whether this task has spent the attempt budget its plan gave it.
 *
 * `maxAttempts` is not a countdown to giving up — nothing here can fail a task,
 * and f9f496c's version, which did, is not what came back. It is a boundary on
 * how long one *formulation* of a task may be retried. Without one the count
 * only climbed, which is both a display defect (a row reading "attempt 7 of 3")
 * and the thing that defect was reporting: a supervisor free to send a fourth,
 * fifth and sixth phrasing of an instruction that has already failed three
 * times. At the boundary the choice narrows to the two decisions that change
 * something — split it, or rebuild it — and the budget then starts over on
 * whatever comes out. See `allowedVerdicts` in supervisorDecision.ts.
 */
export function attemptsExhausted(task: Task): boolean {
  return task.attempts >= Math.max(1, task.maxAttempts);
}

/**
 * A committed replacement of one task by smaller ordered tasks — what failure
 * decomposition produces and `applyVerdictSplit` commits. There is deliberately
 * no failure verdict: every path out of a failed attempt is a retry, a rewrite
 * or a replacement, never "impossible".
 */
export interface SupervisorDecision {
  verdict: 'SPLIT';
  feedback: string;
  /** The tasks that replace this one, in order. */
  splitInto?: NewTask[];
  /** What the decision itself cost — part of the task's bill like any other run. */
  usage: Usage;
}

