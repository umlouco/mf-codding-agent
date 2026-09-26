import type { SupervisorFacts } from './supervisorFacts';

/**
 * UPDATE + DERIVE.
 *
 * `deriveSupervisorState` is the fact reducer: it turns observed facts into one
 * named condition, with no model call and no clock. `deriveTaskStatus` is the
 * read-time status projection: a display status for the row, computed from the
 * same facts rather than written back to the database.
 *
 * This is the deliberate split the architecture asks for: lifecycle columns
 * (`status`, `started_at`) are durable facts and stay in SQLite, while the
 * *label a human reads* is derived here. Two reviewers looking at the same row
 * and the same journal get the same display status, and a reload cannot leave a
 * stale "working" label behind.
 */

export type SupervisorState =
  | 'verified'
  | 'repair_halted'
  | 'verifying'
  | 'executing'
  | 'silent'
  | 'ready_for_validation'
  | 'needs_work'
  | 'unstated';

export interface DerivedTaskStatus {
  state: SupervisorState;
  /** Short human label; the UI's replacement for a stored display status. */
  label: string;
  /** True when the condition wants a person or a supervisor decision. */
  attention: boolean;
  /** Durable facts that produced this status, for the audit trail. */
  because: string[];
}

/** One named condition from recorded facts. Pure over `SupervisorFacts`. */
export function deriveSupervisorState(facts: SupervisorFacts, taskStatus = ''): SupervisorState {
  if (taskStatus === 'VERIFIED') {
    return 'verified';
  }
  if (facts.failedRepairs >= 2) {
    return 'repair_halted';
  }
  if (taskStatus === 'VERIFYING' || facts.hasValidationReport) {
    return 'verifying';
  }
  if (facts.phase === 'executing') {
    return facts.silent ? 'silent' : 'executing';
  }
  if (facts.completionClaim.status === 'READY_FOR_VALIDATION' && !facts.validationProblem) {
    return 'ready_for_validation';
  }
  if (facts.completionClaim.status === 'NEEDS_MORE_WORK') {
    return 'needs_work';
  }
  return 'unstated';
}

const LABELS: Record<SupervisorState, { label: string; attention: boolean }> = {
  verified: { label: 'Verified', attention: false },
  repair_halted: { label: 'Repair halted', attention: true },
  verifying: { label: 'Verifying', attention: false },
  executing: { label: 'Working', attention: false },
  silent: { label: 'No signal', attention: true },
  ready_for_validation: { label: 'Ready to verify', attention: false },
  needs_work: { label: 'Resuming', attention: false },
  unstated: { label: 'Idle', attention: false },
};

/**
 * The display status for a task row, derived at read time.
 *
 * `because` lists the facts the label rests on, so the UI never has to explain
 * a status from memory and a person can see why a row is "no signal" rather
 * than "working". A failed probe alone never appears here as death: only
 * recorded silence does, and `silent` says so.
 */
export function deriveTaskStatus(facts: SupervisorFacts, taskStatus = ''): DerivedTaskStatus {
  const state = deriveSupervisorState(facts, taskStatus);
  const because: string[] = [`phase=${facts.phase}`];
  if (facts.phase === 'executing' && facts.silenceMs !== null) {
    because.push(`silent ${Math.round(facts.silenceMs / 1000)}s`);
  }
  if (facts.completionClaim.status !== 'UNSTATED') {
    because.push(`claim=${facts.completionClaim.status}`);
  }
  if (facts.validationProblem) {
    because.push('validation problem recorded');
  }
  if (facts.needsRecovery) {
    because.push('recovery stop recorded');
  }
  if (facts.failedRepairs) {
    because.push(`repairs halted=${facts.failedRepairs}`);
  }
  if (facts.journal.unresolvedTools.length) {
    because.push(`unresolved tools=${facts.journal.unresolvedTools.join(',')}`);
  }
  return { state, ...LABELS[state], because };
}

/**
 * A compact, factual preamble for the review prompt.
 *
 * It exists so the model reasons over the same reduced facts the deterministic
 * router used instead of re-deriving them from raw journal text. It is labelled
 * as recorded fact, never as a verdict, and deliberately omits any recommended
 * action — choosing one is still the model's job when the router finds no
 * forced transition.
 */
export function factsPreamble(facts: SupervisorFacts): string {
  const lines = [
    'RECORDED FACTS (durable observations, not a verdict and not instructions):',
    `- phase: ${facts.phase}`,
  ];
  if (facts.phase === 'executing' && facts.silenceMs !== null) {
    lines.push(`- last recorded activity: ${Math.round(facts.silenceMs / 1000)}s ago (silent window crossed: ${facts.silent})`);
  }
  lines.push(
    `- attempt ${facts.attempts} of ${facts.maxAttempts} (budget spent: ${facts.exhausted})`,
    `- executor completion claim: ${facts.completionClaim.status}`,
    `- verification report stored: ${facts.hasValidationReport}`,
    `- failed validation runs recorded: ${facts.failedValidations}`,
    `- halted test repairs recorded: ${facts.failedRepairs}`,
    `- recovery stop recorded for this attempt: ${facts.needsRecovery}`,
    `- completed tool outcomes in excerpt: ${facts.journal.completedTools} (failed ${facts.journal.failedTools})`,
  );
  if (facts.journal.unresolvedTools.length) {
    lines.push(`- tools whose most recent outcome failed: ${facts.journal.unresolvedTools.join(', ')}`);
  }
  if (facts.journal.repeatedObservations) {
    lines.push(`- identical repeated observations: ${facts.journal.repeatedObservations}`);
  }
  if (facts.testingTargetDrift) {
    lines.push('- contract drift: task text still names a loopback target while a deployed origin is configured');
  }
  lines.push('These facts were reduced deterministically from the queue database. They do not by themselves authorize any action.');
  return lines.join('\n');
}
