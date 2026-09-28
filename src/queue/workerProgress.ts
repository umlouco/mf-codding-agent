import type { TaskEvent } from './db';

/**
 * Whether a running coder is visibly moving: it changed files or ran tests.
 *
 * Stopping a coder throws away everything in its context. On a local model that
 * can be an hour of reading and one edit away from done, and the next attempt
 * starts over from the task text — which is how a queue can work for hours on a
 * rename it never finishes. Reading, searching and listing are not movement
 * here: a worker that only looks around is exactly the one a supervisor should
 * be free to stop.
 *
 * Reads the journal lines `formatToolEvent` writes — `name(args) → status` —
 * and counts only successful completed outcomes, never the `→ start` lines.
 */
const EDIT_TOOL = /(?:^|__)(?:write_file|edit_file|multi_edit|apply_patch|apply_diff|replace_in_file|Write|Edit|MultiEdit|delete_file|move_file|rename_file)$/;
const TEST_TOOL = /(?:^|__)(?:playwright_test|run_tests?|test_run)$/i;
const SHELL_TOOL = /(?:^|__)(?:run_shell|shell|bash|Bash|exec|run_command)$/;
// A heuristic over the briefed command text: in-place edits, redirections into
// files (not `2>/dev/null`), file moves, installs and test runners.
const SHELL_CHANGE = new RegExp([
  String.raw`\bsed\s+(?:-\w+\s+)*-\w*i`,
  String.raw`\bperl\s+-\w*i`,
  String.raw`\btee\s`,
  String.raw`(?:^|[^0-9&>=\-])>>?\s*[^\s&|>]`,
  String.raw`\b(?:mv|cp|rm|mkdir|touch|patch)\s`,
  String.raw`\bgit\s+(?:apply|commit|mv|rm|checkout)\b`,
  String.raw`\b(?:npm|pnpm|yarn|composer)\s+(?:i|install|add|run)\b`,
  String.raw`\b(?:playwright\s+test|phpunit|pytest|go\s+test|node\s+--test)\b`,
].join('|'));

/** Names of the tools, oldest first, whose successful outcome counts as movement. */
export function workerProgress(events: readonly TaskEvent[]): string[] {
  const moved: string[] = [];
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (event.actor !== 'executor' || event.kind !== 'tool') continue;
    // Anchored on the outcome fingerprint: string inputs may span lines.
    const match = /^([^\s(]+)\(([\s\S]*?)\) → ([\w-]+)(?: in [\d.]+ms)?\n\[outcome:/.exec(event.message);
    if (!match || !/^(?:ok|done)$/.test(match[3])) continue;
    const [, name, args] = match;
    if (EDIT_TOOL.test(name) || TEST_TOOL.test(name) || (SHELL_TOOL.test(name) && SHELL_CHANGE.test(args))) {
      moved.push(name);
    }
  }
  return moved;
}
