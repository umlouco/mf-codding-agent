import { Task, NewTask, Usage } from './db';
import { squash } from './agentHistory';

// ---- supervisor --------------------------------------------------------

/**
 * There is deliberately no failure verdict.
 *
 * A run that can declare a task impossible will declare a task impossible, and
 * the queue then stops with work outstanding and nobody watching — which is the
 * one outcome an unattended overnight run must not have. Every path out of a
 * failed attempt goes back through the supervisor rewriting the task.
 */
export type Verdict = 'VERIFIED' | 'REVERIFY' | 'RETRY' | 'SPLIT' | 'REPAIR_TESTS' | 'RESET_FROM';

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
 * whatever comes out. See `escalate` and the RETRY case in the orchestrator.
 */
export function attemptsExhausted(task: Task): boolean {
  return task.attempts >= Math.max(1, task.maxAttempts);
}

/**
 * What the attempt budget means to this particular review.
 *
 * Below the ceiling the count is context and nothing else: a task on its second
 * attempt is judged on its evidence exactly as the first was, because rejecting
 * work for being late is how a correct implementation gets thrown away. At the
 * ceiling it becomes an instruction, because by then the count *is* evidence —
 * three failures against one description are not three accidents.
 */
export function ceilingNotice(task: Task): string {
  if (!attemptsExhausted(task)) {
    return `This is attempt ${task.attempts} of ${task.maxAttempts}. Judge the recorded work on its own
merits — the count is context here, not a reason to accept or reject anything.`;
  }
  return `ATTEMPT BUDGET SPENT: this is attempt ${task.attempts} of ${task.maxAttempts}, the last one this
implementation retry budget allows before reassessment. Diagnose the recorded failure: it may be a tool invocation,
environment problem, model mistake, or task ambiguity. Preserve the required acceptance criteria;
do not weaken them to obtain a PASS. Repeating the same failed approach is not a recovery.
If the evidence is not sufficient, choose exactly one:
 - REVERIFY, when implementation has no observed defect and the independent verifier must finish
   a check, correct a tool invocation, or complete its report. Preserve the task and acceptance
   criteria. An execution attempt ceiling does not require rewriting working implementation.
 - SPLIT, when scope is the obstacle: the report reads as several unfinished threads rather than
   one unfinished thing, or no single agent can hold all of this at once. Return the ordered
   smaller tasks that replace it.
 - REPAIR_TESTS, for a test or harness defect requiring a supervisor-owned rewrite;
 - RETRY, for an application code defect requiring executor changes, or a task that has drifted
   from the owner's requirements. Preserve the goal and required behavior. Write a self-contained task
   using the observed failures, completed work, and a concrete different approach.
REVERIFY retains the implementation and its attempt count. A rewritten or split implementation
starts with a fresh attempt budget; preserve completed work and every acceptance criterion.`;
}

/**
 * True for a value that is the supervisor's verdict rather than something it
 * quoted on the way to reaching one — a JSON snippet from a file it read, or an
 * example in its own reasoning.
 */
export function isReview(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return 'verdict' in v || 'feedback' in v || 'taskEdits' in v || 'splitInto' in v;
}

export interface SupervisorDecision {
  verdict: Verdict;
  feedback: string;
  /** Only meaningful for RESET_FROM: the sequence number to roll back to. */
  resetFromSeq?: number;
  /** Only meaningful for SPLIT: the tasks that replace this one, in order. */
  splitInto?: NewTask[];
  /** Optional edits the supervisor wants applied to upcoming tasks. */
  taskEdits?: {
    seq: number;
    description?: string;
    implVerifyPrompt?: string;
    solutionVerifyPrompt?: string;
    solutionVerifyCommand?: string;
  }[];
  /**
   * This decision was made at the attempt ceiling, so what it replaces the task
   * with is a restructuring rather than another pass at the same one — which is
   * what entitles it to a fresh attempt budget. Only meaningful for RETRY; a
   * SPLIT replaces the row outright and its parts start at zero regardless.
   */
  escalated?: boolean;
  /** What the review itself cost — part of the task's bill like any other run. */
  usage: Usage;
}

/** True when `next` is a real rewrite rather than a blank or a copy. */
export function rewritten(next: string | undefined, current: string): boolean {
  const n = squash(String(next ?? ''));
  return n.length >= 40 && n !== squash(current);
}

export function addUsage(into: Usage, add: Usage): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
}

export const CORRECTION_MARK = '--- CORRECTION AFTER ATTEMPT';

/**
 * The last-resort rewrite: the original task with the supervisor's correction
 * bolted on as an instruction the executor cannot miss.
 *
 * Any correction from an earlier attempt is stripped first. Stacking them would
 * grow the description without bound — and worse, would hand the executor a
 * stack of superseded instructions with the current one buried at the end,
 * which is the opposite of what this is for.
 */
export function appendCorrection(task: Task, feedback: string): string {
  const note =
    feedback.trim() ||
    'The previous attempt did not pass verification and the supervisor did not say why. ' +
      'Read the files this task names before changing anything, confirm what is already ' +
      'there, and report precisely what you find.';
  const base = task.description.split(CORRECTION_MARK)[0].trimEnd();
  return `${base}

${CORRECTION_MARK} ${task.attempts} (apply while preserving required behavior and acceptance criteria) ---
${note}`;
}

/**
 * Tells the supervisor how many times it has already rewritten this task.
 *
 * Without it every review looks like the first one. The supervisor reads a
 * description, does not recognise it as its own work, and writes the same
 * correction again — which is what an infinite loop looks like from the inside.
 */
export function rewriteNotice(rewrites: number): string {
  if (rewrites <= 0) {
    return '';
  }
  return `
The description below is not the original: you have already rewritten this task ${rewrites} time(s),
and the latest attempt still did not pass. Compare the current evidence with earlier failures.
Preserve what works and change the failed approach. Do not assume the requirements are wrong
merely because a worker failed to satisfy them.
`;
}
