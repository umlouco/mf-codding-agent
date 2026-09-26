import { isSupervisorAction } from './supervisorGraph';

/**
 * The structural check at the model boundary.
 *
 * `extractJson` finds a candidate value; this decides whether that value is a
 * supervision reply at all (an object naming a routable action). Whether the
 * action is legal for the recorded facts is `supervisorGraph.guardViolation`;
 * whether a rewrite actually changed anything is `supervisorGraph.rewriteViolation`.
 */

export interface RawDecision {
  action?: unknown;
  reason?: unknown;
  guidance?: unknown;
  rewrittenDescription?: unknown;
  solutionVerifyPrompt?: unknown;
  splitInto?: unknown;
  targetCheck?: unknown;
  [key: string]: unknown;
}

/** A candidate envelope: an object naming an action this graph will route. */
export function isDecisionEnvelope(value: unknown): value is RawDecision {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    isSupervisorAction((value as RawDecision).action);
}
