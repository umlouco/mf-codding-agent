import { Usage } from './db';
import { CognitiveBinding } from './cognition';

/**
 * Agent runners for autonomous runs.
 *
 * Every run here is *ephemeral*: spawn a core process, initialise it on the
 * model for that role, send exactly one turn, kill the process. The Go core
 * binds one LLM provider for its whole lifetime, so a separate Supervisor and
 * Execution model has to mean a separate process — and that constraint gives
 * us the isolated context window the design wants for free. A worker cannot
 * leak state into the next task because there is no next task for it.
 */

export type Role = 'planner' | 'supervisor' | 'executor';

export interface RoleConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  effort: string;
}

export class AgentRunError extends Error {}

/**
 * One timestamped line of what a worker is doing, on its way to the journal.
 */
export interface ActivityRecord {
  phase: string;
  detail: string;
  at: number;
}

/**
 * Spawns a throwaway core on `role`'s model, sends one prompt, and tears the
 * process down — including when the turn throws.
 */
export interface TurnResult {
  text: string;
  /** `max_iterations` means the worker was cut off, not that it finished. */
  stopReason: string;
  /** Tokens this turn spent, cumulative over its rounds. */
  usage: Usage;
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type ReviewOptions = Pick<RunOptions, 'onActivity' | 'onEvent' | 'onAbort' | 'cognition'> & { projectNotes?: string; failedRepairs?: number; recoveryContext?: string };

export interface RunOptions {
  /** Only the dedicated supervisor test-repair turn may edit while supervising. */
  allowTestEdits?: boolean;
  /** Validators may inspect and execute checks but cannot rewrite workspace files. */
  verificationOnly?: boolean;
  /** Repair a response using supplied evidence without starting another tool investigation. */
  formatOnly?: boolean;
  /** Durable work identity; independent from this disposable process and conversation. */
  cognition?: CognitiveBinding;
  /** Retrieve relevant workspace graph knowledge before a fresh worker starts. */
  memoryQuery?: string;
  maxIterations?: number;
  onEvent?: (method: string, params: any) => void;
  onCancellable?: (cancel: () => void) => void;
  /** Native workers accept advice at the next tool-safe model boundary. */
  onSteerable?: (steer: (text: string) => Promise<boolean>) => void;
  /**
   * Hands back a hard stop: kills the core process rather than asking it to
   * stop. `onCancellable` goes through the core, so it is worth nothing against
   * a core that has stopped reading its own stdin — and that is the only case
   * anyone needs to abort a turn from the outside. Killing the process is what
   * rejects the in-flight request, which is what un-wedges the caller.
   */
  onAbort?: (abort: () => void) => void;
  /** Where the worker's activity records go. */
  onActivity?: (a: ActivityRecord) => void;
}
