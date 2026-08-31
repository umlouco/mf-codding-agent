export type ValidationConclusion = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface ValidationCheck {
  kind: 'inspection' | 'command' | 'test' | 'browser' | 'other';
  name: string;
  passed: boolean;
  evidence: string;
}

/** Evidence produced by the executor and persisted before supervision starts. */
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
}

function isEnvelope(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    'validation' in (value as Record<string, unknown>);
}

const clean = (value: unknown, max = 8000): string => String(value ?? '').trim().slice(0, max);

/**
 * Converts the executor's final JSON into the stable database representation.
 * A malformed or cut-off report is deliberately INCOMPLETE: absence of
 * evidence can never turn into a successful validation by parsing accident.
 */
export function parseExecutorValidation(text: string, cutOff: boolean): ExecutorValidation {
  if (cutOff) {
    return incomplete('The executor exhausted its tool-call budget before completing validation.', text);
  }

  try {
    const envelope = extractEnvelope(text);
    const raw = envelope.validation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return incomplete('The executor did not return a structured validation object.', text);
    }
    const value = raw as Record<string, unknown>;
    const named = clean(value.conclusion, 20).toUpperCase();
    const conclusion: ValidationConclusion =
      named === 'PASS' || named === 'FAIL' || named === 'INCOMPLETE' ? named : 'INCOMPLETE';
    const checks = Array.isArray(value.checks)
      ? value.checks.slice(0, 40).map(normalizeCheck).filter((c): c is ValidationCheck => !!c)
      : [];
    return {
      conclusion,
      summary: clean(value.summary),
      implementationEvidence: clean(value.implementationEvidence),
      behaviorEvidence: clean(value.behaviorEvidence),
      checks,
      remaining: clean(value.remaining),
    };
  } catch {
    return incomplete('The executor reply could not be parsed as structured validation.', text);
  }
}

function extractEnvelope(text: string): ExecutorEnvelope {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  candidates.push(text);
  for (const candidate of candidates.reverse()) {
    for (let start = candidate.lastIndexOf('{'); start >= 0; start = candidate.lastIndexOf('{', start - 1)) {
      try {
        const value = JSON.parse(candidate.slice(start).trim());
        if (isEnvelope(value)) {
          return value as ExecutorEnvelope;
        }
      } catch {
        // Try an earlier opening brace; executor prose and evidence can contain JSON.
      }
    }
  }
  throw new Error('no executor validation envelope');
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

export function serializeValidation(report: ExecutorValidation): string {
  return JSON.stringify(report);
}

export function validationForSupervisor(serialized: string): string {
  if (!serialized.trim()) {
    return JSON.stringify(incomplete('No executor validation was stored for this attempt.', ''));
  }
  try {
    return JSON.stringify(JSON.parse(serialized), null, 2);
  } catch {
    return JSON.stringify(incomplete('The stored executor validation is invalid JSON.', serialized), null, 2);
  }
}
