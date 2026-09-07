import { AgentRunError } from './agentTypes';

// ---- JSON extraction ---------------------------------------------------

/**
 * Pulls a usable JSON value out of a model reply.
 *
 * Local models wrap JSON in prose, fences, or thinking blocks and sometimes emit
 * trailing commas, single quotes, or unquoted keys — so this scans for balanced
 * `[`/`{` rather than trusting the whole reply to parse, and repairs common
 * formatting issues before handing off to JSON.parse.
 *
 * `want` is what makes it reliable now that a turn's result carries every
 * round's text and not just the last one (see agent.go). The reply is prose
 * *then* JSON, and prose is full of brackets: a file name in square brackets, a
 * markdown checklist, a quoted line of code. Taking the first bracket that
 * parses is how `- [ ] read the core` becomes an empty task list, and giving up
 * when it does not parse is how `[package.json]` loses the plan that follows it.
 * So every bracket in the reply is tried, and the caller says which value it can
 * actually use.
 */
export function extractJson<T>(text: string, want?: (value: unknown) => boolean): T {
  // Try every markdown fence — some models nest JSON inside prose or multiple
  // fences, so the last fence often wins for a model that thinks before writing.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenced: string[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) {
    fenced.push(fm[1]);
  }
  const candidates = fenced.length > 0 ? [...fenced, text] : [text];

  for (const c of candidates) {
    // Some models emit a thinking block before the JSON. Strip it so the
    // balanced-bracket scan does not start inside a prose paragraph.
    const stripped = c.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    for (const parsed of jsonValues(stripped)) {
      if (!want || want(parsed)) {
        return parsed as T;
      }
    }
  }
  throw new AgentRunError('the model did not return parseable JSON');
}

/**
 * Every bracket position worth trying in one candidate.
 *
 * Capped because matching a bracket costs a scan, and an executor report that
 * quotes a diff can carry hundreds of them. The answer is near the front of any
 * reply that has one.
 */
export const MAX_BRACKETS = 400;

/** Parseable JSON values in `src`, in the order they appear. */
export function* jsonValues(src: string): Generator<unknown> {
  let seen = 0;
  for (let start = 0; start < src.length; start++) {
    const ch = src[start];
    if (ch !== '[' && ch !== '{') {
      continue;
    }
    if (++seen > MAX_BRACKETS) {
      return;
    }
    const end = matchingBracket(src, start);
    if (end < 0) {
      continue;
    }
    const parsed = tryParse(src.slice(start, end + 1));
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

/**
 * Index of the bracket closing the one at `start`, or -1 when nothing does.
 *
 * Quote- and escape-aware, so a brace inside a description string does not open
 * a level that never closes.
 */
export function matchingBracket(src: string, start: number): number {
  const open = src[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Attempts to parse a JSON slice, repairing common model formatting errors.
 *
 * Returns undefined when every attempt fails, so the caller can try the next
 * candidate rather than throwing immediately.
 */
export function tryParse(slice: string): unknown {
  // 1. Strict parse — most replies pass on the first try.
  try {
    return JSON.parse(slice);
  } catch { /* fall through */ }

  // 2. Trailing commas before ] or }. DeepSeek and kimi do this regularly.
  try {
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
  } catch { /* fall through */ }

  // 3. Single-quoted keys and strings. Convert them to double quotes,
  //    being careful not to touch quotes that are already inside strings.
  try {
    const dq = slice.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
    return JSON.parse(dq);
  } catch { /* fall through */ }

  // 4. Unquoted keys (identifier-like). Prepend a quote before the first `:`
  //    on each line that starts bare. Crude but covers the commonest case.
  try {
    const uq = slice.replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
    return JSON.parse(uq);
  } catch { /* fall through */ }

  // 5. Combined: trailing commas + unquoted keys + single quotes.
  try {
    const combined = slice
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
    return JSON.parse(combined);
  } catch { /* fall through */ }

  return undefined;
}

/**
 * If `parsed` is an object with exactly one property whose value is an array,
 * return that array. Otherwise return `parsed` unchanged.
 *
 * This handles the common pattern where models wrap their task list in an
 * envelope like `{"tasks": [...]}` or `{"plan": [...]}`.
 */
export function unwrapArray(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length === 1) {
    const val = (parsed as Record<string, unknown>)[keys[0]];
    if (Array.isArray(val)) {
      return val;
    }
  }
  // Multiple keys — scan for any array-valued property.
  for (const k of keys) {
    const val = (parsed as Record<string, unknown>)[k];
    if (Array.isArray(val)) {
      return val;
    }
  }
  return parsed;
}

// ---- planner -----------------------------------------------------------

/** True for a value the planner can turn into tasks. */
export function isPlan(value: unknown): boolean {
  const list = unwrapArray(value);
  return Array.isArray(list) && list.length > 0;
}
