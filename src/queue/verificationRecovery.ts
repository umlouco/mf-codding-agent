import type { Task } from './db';

/** Missing observations cannot authorize product edits through retry feedback.
 * A model must first establish a failed, explicit check of assigned acceptance.
 * Legacy reports remain on their existing review path until host verification.
 */
export function implementationRetryProblem(task: Task): string {
  if (task.kind === 'phase') return '';
  let report: any;
  try { report = JSON.parse(task.validationReport); } catch { return ''; }
  if (report.verificationPlan?.version !== 1 || !Array.isArray(report.verificationReceipts)) return '';
  if (report.verificationReceipts.some((receipt: any) => receipt.executionSucceeded === true &&
      receipt.assertion === 'failed' && !receipt.truncated &&
      !/invocation failure|execution error|not executed|no reliable exit code/i.test(receipt.problem || ''))) return '';
  return 'The host report contains no successfully executed, explicitly failed acceptance assertion. ' +
    'Missing evidence, an unasserted browser value, or a broken checking tool does not establish an implementation defect. ' +
    'Finish verification of the assigned local requirements with explicit expected results and correct prerequisites. ' +
    'Do not invent new behavior, timing limits, or unfinished sibling requirements to justify code edits.';
}
