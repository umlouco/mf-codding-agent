/**
 * The supervisor's control protocol as an explicit state machine.
 *
 * The action vocabulary below and the guards around it used to live inline in
 * `monitor.ts`, spread across a long prompt and a hand-written `normalize` that
 * threw a different sentence for each malformed decision. This module is the
 * single typed description of which transitions are legal: the prompt asks the
 * model to *route* through this graph, and `guardViolation` is the deterministic
 * router that rejects a transition the recorded facts forbid.
 *
 * Nothing here calls a model, reads a clock, or touches the database. The same
 * facts and the same proposed action always produce the same verdict, which is
 * what lets a supervision decision be replayed and audited.
 */

export const SUPERVISOR_ACTIONS = [
  'CONTINUE_EXECUTION',
  'STOP_AND_REWRITE_TASK',
  'STOP_AND_REWRITE_VALIDATION',
  'STOP_AND_REWRITE_TESTS',
  'SPLIT_TASK',
  'START_VALIDATION',
  'STOP_AND_DECOMPOSE_TASK',
] as const;

export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];

export function isSupervisorAction(value: unknown): value is SupervisorAction {
  return typeof value === 'string' && (SUPERVISOR_ACTIONS as readonly string[]).includes(value);
}

/** The smallest shape a split proposal must have to be commit-able. */
export interface SplitPartShape {
  title?: unknown;
  description?: unknown;
  solutionVerifyPrompt?: unknown;
}

export function isCompleteSplitPart(part: SplitPartShape | null | undefined): boolean {
  return !!part &&
    typeof part.title === 'string' && !!part.title.trim() &&
    typeof part.description === 'string' && !!part.description.trim() &&
    typeof part.solutionVerifyPrompt === 'string' && !!part.solutionVerifyPrompt.trim();
}

export interface TargetCheckShape {
  configuredUrl?: unknown;
  preservesOwnerScope?: unknown;
  observedWork?: unknown;
  requiredWork?: unknown;
}

/**
 * Recorded facts a proposed action must not contradict. These are the guards
 * that used to be scattered `if` statements inside `normalize`; keeping them
 * here gives the same rejections a stable, testable home.
 */
export interface GuardFacts {
  /** The stop reason is a wrong testing target or repeated unchanged failure. */
  needsRecovery: boolean;
  /** Test-repair turns already halted on this task. */
  failedRepairs: number;
  /** A committed local execution ticket with fixed acceptance criteria. */
  localScope: boolean;
  /** The configured deployed testing origin, empty when none is set. */
  testingUrl: string;
}

export interface GuardedDecision {
  action: SupervisorAction;
  hasSplitProposal: boolean;
  splitInto?: SplitPartShape[];
  rewrittenDescription: string;
  /** Trimmed replacement prompt; empty when absent. */
  solutionVerifyPrompt: string;
  /** True when the reply actually supplied a string verification prompt. */
  hasVerificationRewrite: boolean;
  targetCheck?: TargetCheckShape;
  /** Current contract, for "this is not a rewrite" checks. */
  taskDescription: string;
  taskSolutionVerifyPrompt: string;
}

/**
 * Rejects an action the recorded facts forbid, before any field is trusted.
 *
 * Returns the rejection sentence, or `undefined` when the transition is legal.
 * The order of checks is the protocol's order: repair exhaustion first, then
 * recovery, then split shape, then the committed local contract, then the
 * fields each rewrite action requires, then the configured target comparison.
 */
export function guardViolation(decision: GuardedDecision, facts: GuardFacts): string | undefined {
  const { action } = decision;

  if (facts.failedRepairs >= 2 && action === 'STOP_AND_REWRITE_TESTS') {
    return 'Supervisor repair has repeatedly halted. Choose SPLIT_TASK or a materially changed task/validation contract before another repair.';
  }

  if (facts.needsRecovery && action === 'CONTINUE_EXECUTION') {
    return 'The current worker was halted for a wrong testing target or repeated tool failures. CONTINUE_EXECUTION would repeat the rejected approach. Supply a concrete task/validation correction or SPLIT_TASK with smaller steps.';
  }

  if (action === 'SPLIT_TASK' && decision.hasSplitProposal &&
      (!Array.isArray(decision.splitInto) || decision.splitInto.length < 2 ||
        decision.splitInto.some(part => !isCompleteSplitPart(part)))) {
    return 'SPLIT_TASK requires at least two complete splitInto parts, each with title, description and a behavior verification prompt.';
  }

  if (facts.localScope && (action === 'STOP_AND_REWRITE_TASK' || action === 'STOP_AND_REWRITE_VALIDATION')) {
    return 'A committed local execution ticket has fixed acceptance requirements. Do not rewrite it into the parent objective. Use CONTINUE_EXECUTION with concrete local recovery guidance, START_VALIDATION when ready, or STOP_AND_DECOMPOSE_TASK for remaining work within this ticket only.';
  }

  if (action === 'STOP_AND_REWRITE_TASK' && !decision.rewrittenDescription.trim()) {
    return 'STOP_AND_REWRITE_TASK requires rewrittenDescription containing the complete corrected task.';
  }

  if (action === 'STOP_AND_REWRITE_VALIDATION' && !decision.hasVerificationRewrite) {
    return 'STOP_AND_REWRITE_VALIDATION requires a replacement behavior verification prompt.';
  }

  if (facts.testingUrl) {
    const check = decision.targetCheck;
    if (!check || check.configuredUrl !== facts.testingUrl ||
        typeof check.preservesOwnerScope !== 'boolean' ||
        typeof check.observedWork !== 'string' || !check.observedWork.trim() ||
        typeof check.requiredWork !== 'string' || !check.requiredWork.trim()) {
      return 'The fixed testing environment requires targetCheck with the exact configuredUrl, requiredWork, observedWork, and a boolean preservesOwnerScope. Compare the actual application and behavior, not just the server address.';
    }
    if (!check.preservesOwnerScope &&
        (decision.action === 'CONTINUE_EXECUTION' || decision.action === 'START_VALIDATION')) {
      return 'The target comparison reports scope drift. Do not continue or validate that approach; correct the task and its verification requirements while preserving the owner requirements.';
    }
  }

  return undefined;
}

/**
 * The second pass, run after field normalization: a rewrite must actually
 * change something. Kept separate because it compares the *normalized* strings
 * against the current contract, which callers only have after trimming.
 */
export interface RewriteCheck {
  action: SupervisorAction;
  rewrittenDescription?: string;
  solutionVerifyPrompt?: string;
  taskDescription: string;
  taskSolutionVerifyPrompt: string;
}

export function rewriteViolation(decision: RewriteCheck): string | undefined {
  if (decision.action === 'STOP_AND_REWRITE_TASK' &&
      decision.rewrittenDescription === decision.taskDescription.trim()) {
    return 'STOP_AND_REWRITE_TASK requires changed rewrittenDescription, not the current task repeated. If only checks are wrong, use STOP_AND_REWRITE_VALIDATION with changed verification fields.';
  }
  if (decision.action === 'STOP_AND_REWRITE_VALIDATION' &&
      !(decision.solutionVerifyPrompt !== undefined &&
        decision.solutionVerifyPrompt !== decision.taskSolutionVerifyPrompt.trim())) {
    return 'STOP_AND_REWRITE_VALIDATION requires changed verification fields, not the current checks repeated.';
  }
  return undefined;
}

