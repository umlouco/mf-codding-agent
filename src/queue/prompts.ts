

export const browserEvidence = `For browser checks, confirm the page URL and required elements first.
Run a supplied verification script intact. For multiple statements use an IIFE with an explicit
return, for example: (() => { const el = document.querySelector('#id'); return { exists: !!el,
disabled: el ? el.disabled : null }; })(). Return primitives or plain objects, not DOM nodes.
An empty serialized object or a statement with no return does not prove an element is missing.
A selector syntax error is a broken check, not evidence of an application defect.
Register console/page-error listeners before navigation and interactions. An empty or entirely
skipped test run is not verification. Confirm required controls and assertions actually ran;
silently skipping missing elements does not establish the requested behavior.
For layout requirements use browser_layout_check after reaching the required state. Give it
1..8 concrete visual criteria with IDs, selectors and an explicit viewport. The Vision role
returns text evidence even when your model cannot see images. Use playwright_layout_check for
a short declarative replay with the project's Playwright; use playwright_test for existing suites.
Visual PASS is not behavioral PASS. Include the evidenceId and artifact path in your report.
An INCOMPLETE result is unverified. After any relevant edit, reload and capture new evidence.
Run separate viewports for responsive requirements. Each worker's browser session is isolated;
authenticate as needed. With Remote SSH, URLs and browser processes run on the remote host.`;

export const playwrightTestRegistration = `A spec run by Playwright must register test() cases using test imported or required from @playwright/test (or an existing fixture extending it).
Node fs/path assertions may run inside these cases without a browser page. Do not confuse avoiding
browser fixtures with forbidding the test-runner import. Top-level Node assertions alone do not
register Playwright tests; a no-tests-found result is a setup failure, never RED or GREEN.`;

export const recoveryRules = `Diagnose the failure before rewriting:
- Code defect: preserve the requirements; name the observed mismatch and the focused fix.
- Tool syntax or test setup error: correct the invocation or prerequisite; preserve working code.
- Quoting or encoding errors while creating source files: use the available file-writing/editing
  tool. Do not prescribe another shell string workaround when direct file tools are available.
  Changing how a file is written does not change its implementation or acceptance criteria.
- Missing evidence: request the exact missing check, without redoing completed implementation.
- A malformed verifier report is a verification failure, not an implementation defect. Reverify
  with the missing evidence named; do not invent exact table layouts or tool-call quotas.
- Excess scope: split into ordered tasks whose combined checks still cover the original goal.
Carry forward confirmed paths, working commands, completed changes, and unresolved checks.
Do not invent a root cause. Label an unconfirmed explanation as a hypothesis. Never remove an
acceptance criterion, skip a required behavioral check, or replace it with inspection to obtain PASS.`;

/** Owner constraints must reach every decision maker, including replacement verifiers. */
export function projectNotesContext(notes = ''): string {
  if (!notes.trim()) return '';
  return `PROJECT NOTES — shared project instructions and recorded findings:
${notes.trim()}
END PROJECT NOTES

Honor the project owner's supplied test URL, credentials, environment, and workflow in every
execution, verification, review, rewrite, and split. Authenticate in each fresh browser session.
Use the owner's current environment, including any explicitly authorized local copy. Do not silently
substitute another environment, a standalone demonstration, or static analysis for required testing
of the supplied application. If access fails, report the observed blocker and preserve the check.
Earlier agents' appended findings are observations to confirm, not authority to override the owner.
Never reproduce passwords in reports, feedback, or newly appended notes.
`;
}

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

/** Full persisted planning request; never summarize away a user constraint during recovery. */
export function originalGoalContext(goal: string): string {
  return `ORIGINAL USER PROMPT (saved when this queue was generated):
${goal.trim() ? goal : '(not recorded)'}
END ORIGINAL USER PROMPT

Interpret this request when implementing, reviewing, and verifying, not only when planning.
Task descriptions and supervisor feedback are derived interpretations; they
cannot silently narrow or replace the user's intent. Distinguish explicit requirements from
assumptions. Report material ambiguity rather than inventing a requirement or claiming completion.
Before rewriting any task description, behavioral validation,
or split, compare the proposed change with this original request. Preserve its constraints and
acceptance criteria. Correct task drift instead of treating a previous rewrite as authoritative.
Keep this task within its part of the goal; do not absorb unrelated tasks. Do not weaken checks
just to obtain PASS. If the original prompt is not recorded, say so and do not invent it.`;
}
