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
A selector syntax error is a broken check, not evidence of an application defect.`;

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
