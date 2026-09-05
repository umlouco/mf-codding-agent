export const reportContract = `The queue report schema below controls your final reply, even if task text
requests another response format (such as only a path, raw JSON analysis, or the word PASS).
That requested content is a task deliverable, not the queue report. Write large deliverables to
a workspace file and report its path; inspect the file during verification. Keep the queue report
under 1200 words. Include concise observed evidence, not full file contents or repeated tool logs.
Never copy expected results as observations. Derive counts, line numbers, and outcomes from tools.
If this turn reaches its limit, preserve changes and report completed work and the next exact check.`;

/** Shared instructions for fresh workers with limited ability to recover from ambiguity. */
export const codingWorkflow = `Work in this order:
1. Identify the required behavior and the files likely to implement it. Read those files and
   nearby tests. Confirm APIs, dependencies, and commands in the repository before using them.
2. Choose the smallest change that satisfies the task. Reuse existing patterns. Preserve public
   interfaces and unrelated user edits. Do not add a dependency unless the task needs it.
3. Implement the change, including relevant error paths and boundary cases. For a bug, add or
   update a focused regression test when the repository supports it.
4. Run the relevant checks and read their actual output. Inspect the final diff for unintended
   changes, missing imports, debug code, and tests weakened to make the change pass.
5. Report changed files, observed check results, and anything still unverified.

If a tool fails, read the error before retrying. Distinguish an invalid tool call, missing setup,
and an application defect. Change code only when evidence points to a code defect. If the same
approach fails twice, use one focused diagnostic or report the blocker; do not repeat cosmetic
variations. Preserve working changes and report a precise next step when you cannot finish.`;

export const browserEvidence = `For browser checks, confirm the page URL and required elements first.
Run a supplied verification script intact. For multiple statements use an IIFE with an explicit
return, for example: (() => { const el = document.querySelector('#id'); return { exists: !!el,
disabled: el ? el.disabled : null }; })(). Return primitives or plain objects, not DOM nodes.
An empty serialized object or a statement with no return does not prove an element is missing.
A selector syntax error is a broken check, not evidence of an application defect.
For layout requirements use browser_layout_check after reaching the required state. Give it
1..8 concrete visual criteria with IDs, selectors and an explicit viewport. The Vision role
returns text evidence even when your model cannot see images. Use playwright_layout_check for
a short declarative replay with the project's Playwright; use playwright_test for existing suites.
Visual PASS is not behavioral PASS. Include the evidenceId and artifact path in your report.
An INCOMPLETE result is unverified. After any relevant edit, reload and capture new evidence.
Run separate viewports for responsive requirements. Each worker's browser session is isolated;
authenticate as needed. With Remote SSH, URLs and browser processes run on the remote host.`;

export const recoveryRules = `Diagnose the failure before rewriting:
- Code defect: preserve the requirements; name the observed mismatch and the focused fix.
- Tool syntax or test setup error: correct the invocation or prerequisite; preserve working code.
- Missing evidence: request the exact missing check, without redoing completed implementation.
- Excess scope: split into ordered tasks whose combined checks still cover the original goal.
Carry forward confirmed paths, working commands, completed changes, and unresolved checks.
Do not invent a root cause. Label an unconfirmed explanation as a hypothesis. Never remove an
acceptance criterion, skip a required behavioral check, or replace it with inspection to obtain PASS.`;

export const executorExample = JSON.stringify({
  report: 'Describe changes actually made.',
  completion: {
    status: 'NEEDS_MORE_WORK',
    summary: 'State what is complete and what remains.',
    filesChanged: [],
    developmentChecks: [],
  },
  notes: '',
}, null, 2);

export const verificationExample = JSON.stringify({
  report: 'Summarize observed verification results.',
  validation: {
    conclusion: 'INCOMPLETE',
    summary: 'State why the evidence supports this conclusion.',
    implementationEvidence: '',
    behaviorEvidence: '',
    checks: [],
    remaining: 'List required checks that could not be completed.',
  },
}, null, 2);

/** Full persisted planning request; never summarize away a user constraint during recovery. */
export function originalGoalContext(goal: string): string {
  return `ORIGINAL USER PROMPT (saved when this queue was generated):
${goal.trim() ? goal : '(not recorded)'}
END ORIGINAL USER PROMPT

Before rewriting any task description, implementation check, behavioral validation, command,
or split, compare the proposed change with this original request. Preserve its constraints and
acceptance criteria. Correct task drift instead of treating a previous rewrite as authoritative.
Keep this task within its part of the goal; do not absorb unrelated tasks. Do not weaken checks
just to obtain PASS. If the original prompt is not recorded, say so and do not invent it.`;
}
