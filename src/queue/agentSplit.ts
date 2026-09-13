import type { NewTask } from './db';
import { AgentRunError } from './agentTypes';

/** A split is one complete replacement proposal, never a usable prefix of one. */
export function parseSupervisorSplit(value: unknown): NewTask[] {
  const fail = (detail: string): never => {
    throw new AgentRunError(`Invalid supervisor SPLIT: ${detail} Original task preserved.`);
  };
  if (!Array.isArray(value) || value.length < 2) {
    fail('at least two complete replacement tasks are required.');
  }
  return (value as unknown[]).map((entry, index) => {
    const label = `splitInto[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} must be an object.`);
    const part = entry as Record<string, unknown>;
    const required = (field: string): string => {
      const next = part[field];
      if (typeof next !== 'string' || !next.trim()) fail(`${label}.${field} must be a nonempty string.`);
      return (next as string).trim();
    };
    if (typeof part.solutionVerifyPrompt !== 'string' || !part.solutionVerifyPrompt.trim()) {
      fail(`${label}.solutionVerifyPrompt must be a nonempty behavior description.`);
    }
    return {
      title: required('title'), description: required('description'),
      solutionVerifyPrompt: required('solutionVerifyPrompt'),
    };
  });
}
