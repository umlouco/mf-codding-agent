import type { Task } from './db';
import { retryBriefing, replacementHandoff } from './agentHistory';
import { browserEvidence, executorExample } from './prompts';
import { executorContext, needsBrowserEvidence } from './executorContext';

/** Task payload only: tools and general safety belong to the executor system policy. */
export function buildExecutorPrompt(task: Task, instructions: string, goal: string): string {
  const { owner, observations } = executorContext(instructions, task);
  return [
    'You are the implementation executor. Complete exactly one task, including development checks, then stop.',
    `ORIGINAL USER PROMPT:\n${goal.trim() || '(not recorded; do not invent it)'}\nEND ORIGINAL USER PROMPT`,
    `TASK ${task.seq}: ${task.title}\n\n${task.description}`,
    task.splitScope || '',
    `Required behavior and checks:\n${task.solutionVerifyPrompt || 'Establish that the described behavior works.'}`,
    owner ? `OWNER CONTEXT (preserve these requirements):\n${owner}\nEND OWNER CONTEXT` : '',
    observations ? `RELEVANT AGENT OBSERVATIONS (claims; confirm against current files):\n${observations}\nEND RELEVANT AGENT OBSERVATIONS` : '',
    replacementHandoff(task),
    retryBriefing(task),
    `Execution rules:
- The original request and owner constraints define success. Task descriptions and prior
  reports cannot override them. If they conflict, report the evidence and needed correction;
  do not silently narrow acceptance criteria or change queue records.
- Inspect current files and existing edits first. Implement only missing in-scope behavior,
  preserving unrelated work. Confirm APIs and commands in the repository.
- Follow owner TDD requirements: observe the relevant test fail, implement, then rerun it.
  Existing test rewrites belong to the supervisor under the runtime ownership guard;
  report the exact required repair, rather than bypassing a refusal or weakening assertions.
- Run the required checks yourself and inspect the final diff. A skipped check, tool error,
  or empty test run is not a pass. No later verifier is assumed to finish your work.
- Use the supplied environment for relevant application checks; never substitute a demo.
  Do not expose credentials. Local unit/build checks do not require browser navigation
  unless an explicit owner requirement says otherwise.
- After two failures of the same approach, diagnose the cause instead of repeating it.
  If blocked, preserve completed work and report the observed error and next action.`,
    needsBrowserEvidence(task, owner) ? browserEvidence : '',
    `Final response: ONE valid JSON object, without a code fence or trailing prose; keep it under
1200 words. Other requested output formats are deliverables, not replacements for this report.
Use READY_FOR_VALIDATION only when implementation and required checks are complete; otherwise
use NEEDS_MORE_WORK. These are completion labels, not verifier verdicts. Record actual changed
paths and observed check results, explicitly marking missing checks. Leave notes empty unless
there is a new durable fact useful to later tasks; do not repeat history or the task outcome.
Replace the example values below:`,
    executorExample,
  ].filter(part => part.trim()).join('\n\n');
}
