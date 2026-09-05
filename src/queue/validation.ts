export type ValidationConclusion = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface ValidationCheck {
  kind: 'inspection' | 'command' | 'test' | 'browser' | 'other';
  name: string;
  passed: boolean;
  evidence: string;
}

/**
 * Evidence produced by the independent verification agent and persisted before
 * the supervisor rules on it.
 *
 * The shape is unchanged from when the implementation agent wrote it itself,
 * and deliberately so — what changed is who is trusted to fill it in, not what
 * counts as evidence.
 */
export interface ExecutorValidation {
  conclusion: ValidationConclusion;
  summary: string;
  implementationEvidence: string;
  behaviorEvidence: string;
  checks: ValidationCheck[];
  remaining: string;
}

interface ExecutorEnvelope {
  report?: unknown;
  validation?: unknown;
  /** Durable facts worth telling every later task — see extractExecutorNotes. */
  notes?: unknown;
}

interface CompletionEnvelope {
  report?: unknown;
  completion?: unknown;
}

const clean = (value: unknown, max = 8000): string => String(value ?? '').trim().slice(0, max);

/** Trimmed, deduplicated strings out of a model-supplied array. */
function cleanList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const line = clean(entry, 500);
    if (line) {
      seen.add(line);
    }
    if (seen.size >= max) {
      break;
    }
  }
  return [...seen];
}

/**
 * Converts the verification agent's final JSON into the stable database
 * representation. A malformed or halted report is deliberately INCOMPLETE:
 * absence of evidence can never turn into a successful validation by parsing
 * accident.
 */
export function parseExecutorValidation(text: string, cutOff: boolean): ExecutorValidation {
  if (cutOff) {
    return incomplete('The verification agent was stopped before it finished checking.', text);
  }

  try {
    const envelope = extractEnvelope<ExecutorEnvelope>(text, 'validation');
    const raw = envelope.validation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return incomplete('The verification agent did not return a structured validation object.', text);
    }
    const value = raw as Record<string, unknown>;
    const named = clean(value.conclusion, 20).toUpperCase();
    const conclusion: ValidationConclusion =
      named === 'PASS' || named === 'FAIL' || named === 'INCOMPLETE' ? named : 'INCOMPLETE';
    const checks = Array.isArray(value.checks)
      ? value.checks.slice(0, 40).map(normalizeCheck).filter((c): c is ValidationCheck => !!c)
      : [];
    const report: ExecutorValidation = {
      conclusion,
      summary: clean(value.summary),
      implementationEvidence: clean(value.implementationEvidence),
      behaviorEvidence: clean(value.behaviorEvidence),
      checks,
      remaining: clean(value.remaining),
    };
    if (conclusion === 'PASS' && (!Array.isArray(value.checks) || value.checks.length > 40 ||
      value.checks.some(check => !normalizeCheck(check)))) {
      return incomplete('Verification checks are malformed or exceed the 40-check report limit.', text);
    }
    const problem = validationProblem(report);
    if (report.conclusion === 'PASS' && problem) {
      report.conclusion = 'INCOMPLETE';
      report.remaining = problem;
    }
    return report;
  } catch {
    return incomplete('The verification reply could not be parsed as structured validation.', text);
  }
}

/**
 * The last complete outer JSON object carrying `key`, scanned in linear time.
 *
 * `key` is what makes this reliable: an agent's report quotes diffs, tool output
 * and sometimes whole JSON files, so "the last object that parses" is regularly
 * something it pasted rather than something it said. Requiring the key names
 * the object the schema actually asked for.
 */
function extractEnvelope<T>(text: string, key: 'validation' | 'completion' | 'notes'): T {
  // One linear scan accepts fences/prose without repairing or inventing data.
  // Consider only complete outer objects: nested quoted artifacts are not reports.
  let start = -1, depth = 0;
  let quoted = false, escaped = false;
  let found: T | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start < 0) {
      if (ch !== '{') continue;
      start = i;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const value = JSON.parse(text.slice(start, i + 1));
        if (!!value && typeof value === 'object' && !Array.isArray(value) &&
          key in (value as Record<string, unknown>)) {
          found = value as T;
        }
      } catch {
        // Malformed JSON remains untrusted.
      }
      start = -1;
    }
  }
  if (found !== undefined && start < 0) return found;
  throw new Error(`no executor ${key} envelope`);
}

/** Necessary evidence floor, not a replacement for independent behavioral review. */
export function validationProblem(report: ExecutorValidation): string {
  if (report.conclusion !== 'PASS') return 'Independent verification did not conclude PASS.';
  if (!report.summary.trim() || !report.implementationEvidence.trim() || !report.behaviorEvidence.trim()) {
    return 'PASS requires a summary, implementation evidence, and behavior evidence.';
  }
  if (report.remaining.trim()) return 'Required verification remains unfinished: ' + report.remaining;
  if (!report.checks.length || report.checks.some(c => c.passed !== true || !c.evidence.trim())) {
    return 'PASS requires passing checks with observed evidence for every reported check.';
  }
  return '';
}

export function storedValidationProblem(serialized: string): string {
  try {
    return validationProblem(parseExecutorValidation(JSON.stringify({ validation: JSON.parse(serialized) }), false));
  } catch {
    return 'Independent verification report is missing or invalid.';
  }
}

function normalizeCheck(raw: unknown): ValidationCheck | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const named = clean(value.kind, 20).toLowerCase();
  const kind: ValidationCheck['kind'] =
    ['inspection', 'command', 'test', 'browser', 'other'].includes(named)
      ? named as ValidationCheck['kind']
      : 'other';
  return {
    kind,
    name: clean(value.name, 500) || 'unnamed check',
    passed: value.passed === true,
    evidence: clean(value.evidence),
  };
}

function incomplete(summary: string, raw: string): ExecutorValidation {
  return {
    conclusion: 'INCOMPLETE',
    summary,
    implementationEvidence: '',
    behaviorEvidence: '',
    checks: [],
    remaining: clean(raw, 4000),
  };
}

/**
 * Pulls the executor's optional "notes" field out of its JSON report — see
 * ExecutorEnvelope and TaskQueue.appendInstruction in db.ts.
 *
 * Best-effort and separate from parseExecutorValidation on purpose: a reply
 * that fails to parse, or omits the field, has simply chosen to add nothing
 * to the shared project notes — that must never read as a validation failure.
 */
export function extractExecutorNotes(text: string): string {
  try {
    const envelope = extractEnvelope<ExecutorEnvelope>(text, 'notes');
    return clean(envelope.notes, 2000);
  } catch {
    return '';
  }
}

export function serializeValidation(report: ExecutorValidation): string {
  return JSON.stringify(report);
}

/** What the implementation agent says about its own work when it stops. */
export type CompletionStatus = 'READY_FOR_VALIDATION' | 'NEEDS_MORE_WORK' | 'UNSTATED';

export interface CompletionClaim {
  status: CompletionStatus;
  summary: string;
  filesChanged: string[];
  developmentChecks: string[];
}

const UNSTATED: CompletionClaim = {
  status: 'UNSTATED',
  summary: '',
  filesChanged: [],
  developmentChecks: [],
};

/**
 * Reads the executor's closing `completion` block.
 *
 * This is the implementation agent grading its own homework, and it is treated
 * accordingly: it never verifies anything and never decides anything on its
 * own. It goes to the supervisor as a *claim*, because "does the agent think it
 * is finished" is precisely the question START_VALIDATION turns on, and the
 * alternative is making the supervisor infer it from prose.
 *
 * UNSTATED is the honest answer when the agent did not say — killed mid-turn,
 * or wrote prose instead of the schema. It must not read as either claim: a
 * worker that never spoke has not declared itself ready, and has not declared
 * itself unfinished either.
 */
export function parseCompletionClaim(text: string): CompletionClaim {
  try {
    const envelope = extractEnvelope<CompletionEnvelope>(text, 'completion');
    const raw = envelope.completion;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return UNSTATED;
    }
    const value = raw as Record<string, unknown>;
    const named = clean(value.status, 30).toUpperCase();
    return {
      status: named === 'READY_FOR_VALIDATION' || named === 'NEEDS_MORE_WORK' ? named : 'UNSTATED',
      summary: clean(value.summary, 4000),
      filesChanged: cleanList(value.filesChanged, 60),
      developmentChecks: cleanList(value.developmentChecks, 40),
    };
  } catch {
    return UNSTATED;
  }
}

/** Renders a claim for the supervisor, labelled as the claim it is. */
export function completionForSupervisor(claim: CompletionClaim): string {
  if (claim.status === 'UNSTATED') {
    return 'The agent made no completion claim. Treat this as "unknown", not as either answer.';
  }
  const lines = [`The agent claims: ${claim.status}`];
  if (claim.summary) {
    lines.push(claim.summary);
  }
  if (claim.filesChanged.length > 0) {
    lines.push(`Files it says it changed: ${claim.filesChanged.join(', ')}`);
  }
  for (const check of claim.developmentChecks) {
    lines.push(`- check it says it ran: ${check}`);
  }
  return lines.join('\n');
}

export function validationForSupervisor(serialized: string): string {
  if (!serialized.trim()) {
    return JSON.stringify(incomplete('No verification report was stored for this attempt.', ''));
  }
  try {
    return JSON.stringify(JSON.parse(serialized), null, 2);
  } catch {
    return JSON.stringify(incomplete('The stored verification report is invalid JSON.', serialized), null, 2);
  }
}

/*
 * `autoVerificationFeedback` used to live here: it read a complete, internally
 * consistent PASS out of the report and returned VERIFIED without asking the
 * supervisor, so a second LLM could not reject good command evidence over how
 * it was presented.
 *
 * It is gone because the report it trusted is no longer written by the agent
 * that did the work. That guard existed to stop the supervisor second-guessing
 * an executor's account of itself; now an independent agent writes the account,
 * and ruling on it is the supervisor's entire job. Auto-accepting a PASS would
 * skip the only judgement left in the loop.
 */
