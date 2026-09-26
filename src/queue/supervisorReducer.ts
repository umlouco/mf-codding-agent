import { SUPERVISOR_ACTIONS, type SupervisorAction } from './supervisorGraph';
import { deriveSupervisorState, deriveTaskStatus, factsPreamble, type DerivedTaskStatus, type SupervisorState } from './supervisorState';
import type { SupervisorFacts } from './supervisorFacts';

/**
 * The supervision reducer.
 *
 * It consumes the observed facts and emits everything that can be established
 * without asking a model:
 *
 *  - the named condition (`state`) and the read-time display status;
 *  - the signals the condition rests on;
 *  - the set of actions the recorded facts still permit (`allowedActions`);
 *  - the factual preamble the prompt will carry.
 *
 * What it deliberately does not do is choose among the permitted actions
 * itself. Unlike Agent Orchestrator, which observes external ground truth
 * (git, pull requests, CI), this system's decisive facts are what an independent
 * verifier reported and whether an implementation direction is sound — and
 * those are exactly the remaining judgement calls. Reducing the decision space
 * and rejecting impossible transitions deterministically is the part that can
 * be made an invariant; choosing among the survivors is still the model's job.
 */

export interface SupervisionSignals {
  /** The executor says it is done and no stored report contradicts that. */
  readyForValidation: boolean;
  /** The executor says it needs more work. */
  needsMoreWork: boolean;
  /** The core halted this attempt for a reason a plain continue would repeat. */
  recovering: boolean;
  /** Test-repair turns have halted at least twice. */
  repairExhausted: boolean;
  /** A recorded tool failure has no later successful outcome in the excerpt. */
  testFailureRecorded: boolean;
  /** Task text still targets loopback while a deployed origin is configured. */
  contractDrift: boolean;
  /** Recorded silence crossed the workspace's silent window. */
  silent: boolean;
  /** The attempt budget is spent. */
  exhausted: boolean;
  /** A stored verification report exists but would not support VERIFIED. */
  validationInvalid: boolean;
}

export interface SupervisionAssessment {
  state: SupervisorState;
  status: DerivedTaskStatus;
  signals: SupervisionSignals;
  /** Actions the recorded facts still permit; empty means nothing to decide. */
  allowedActions: SupervisorAction[];
  /** Deterministic factual preamble for the review prompt. */
  preamble: string;
}

function signalsFor(facts: SupervisorFacts): SupervisionSignals {
  return {
    readyForValidation: facts.completionClaim.status === 'READY_FOR_VALIDATION' && !facts.validationProblem,
    needsMoreWork: facts.completionClaim.status === 'NEEDS_MORE_WORK',
    recovering: facts.needsRecovery,
    repairExhausted: facts.failedRepairs >= 2,
    testFailureRecorded: facts.journal.unresolvedTools.length > 0,
    contractDrift: facts.testingTargetDrift,
    silent: facts.silent,
    exhausted: facts.exhausted,
    validationInvalid: facts.hasValidationReport && !!facts.validationProblem,
  };
}

/**
 * Prunes the graph to the transitions the recorded facts allow. This is the
 * deterministic half of routing: the prompt is told which actions exist, and
 * `guardViolation` rejects any reply that tries one of the removed edges.
 */
export function allowedActions(facts: SupervisorFacts, state: SupervisorState): SupervisorAction[] {
  if (state === 'verified') {
    return [];
  }
  const allowed = new Set<SupervisorAction>(SUPERVISOR_ACTIONS);
  if (facts.needsRecovery) {
    allowed.delete('CONTINUE_EXECUTION');
  }
  if (facts.failedRepairs >= 2) {
    allowed.delete('STOP_AND_REWRITE_TESTS');
  }
  if (facts.localScope) {
    allowed.delete('STOP_AND_REWRITE_TASK');
    allowed.delete('STOP_AND_REWRITE_VALIDATION');
  }
  return SUPERVISOR_ACTIONS.filter(action => allowed.has(action));
}

export function reduceSupervision(facts: SupervisorFacts, taskStatus = ''): SupervisionAssessment {
  const state = deriveSupervisorState(facts, taskStatus);
  return {
    state,
    status: deriveTaskStatus(facts, taskStatus),
    signals: signalsFor(facts),
    allowedActions: allowedActions(facts, state),
    preamble: factsPreamble(facts),
  };
}

/**
 * The action-list sentence the prompt uses, phrased from the reduced facts so
 * a model is never invited to choose a transition the router will reject.
 */
export function allowedActionLine(assessment: SupervisionAssessment): string {
  if (assessment.allowedActions.length === 0) {
    return 'No supervisor action applies to this task in its current recorded state.';
  }
  return `Allowed actions for this review: ${assessment.allowedActions.join(', ')}.`;
}
