import type { NewTask, Task } from './db';

/** A completed supervisor decision is a replacement plan, not another planning request. */
export function verdictReplacementTasks(parts: NewTask[], task: Task, archiveKey: string): NewTask[] {
  if (!Array.isArray(parts) || parts.length < 2) throw Error('A replacement needs at least two complete tasks.');
  for (const [index, part] of parts.entries()) {
    for (const field of ['title', 'description', 'solutionVerifyPrompt'] as const) {
      if (typeof part?.[field] !== 'string' || !part[field]!.trim()) {
        throw Error(`Replacement ${index + 1} is missing its ${field}; the entire plan was rejected.`);
      }
    }
  }
  return parts.map((part, index) => {
    const contract = {
      description: `${part.description.trim()}\n\nProgress-preserving handoff from retired task ${task.id}: ` +
        `The original contract, output, verification reports and journal are archived in queue metadata ${archiveKey}. ` +
        'Inspect current workspace changes and the handoff before acting. Retain completed work and existing tests; ' +
        'perform only this replacement task\'s remaining work. A split does not prove completion.',
      solutionVerifyPrompt: part.solutionVerifyPrompt!.trim(),
    };
    return { ...contract, title: part.title.trim(), maxAttempts: task.maxAttempts, kind: 'task',
      region: JSON.stringify({ scopeSplit: { archiveKey, key: `verdict-${index + 1}`,
        targets: [], workUnit: '', integration: false, source: 'supervisor-verdict', contract } }) };
  });
}
