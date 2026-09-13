import type { NewTask, Task } from './db';
import type { WorkInventory } from './workInventory';

export type ScopeRole = 'executor' | 'validator';
export interface ScopeAssessment {
  action: 'KEEP' | 'SPLIT';
  reason: string;
  execution: { shape: 'focused' | 'cohesive' | 'broad' | 'unknown'; reason: string };
  verification: { shape: 'focused' | 'cohesive' | 'broad' | 'unknown'; reason: string };
  requirements: { key: string; criterion: string }[];
  parts: ScopePart[];
}
export interface ScopePart extends NewTask {
  key: string;
  dependsOn: string[];
  integration: boolean;
  handoff: string;
  covers: string[];
  targets?: string[];
  workUnit?: string;
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Scope decision requires ${label}.`);
  return value.trim();
}

/** Reject incomplete plans as a whole: never silently truncate or drop a branch. */
export function parseScopeAssessment(raw: any, task: Task, inventory?: WorkInventory): ScopeAssessment {
  if (inventory?.strategy === 'blocked') throw Error('Blocked discovery cannot authorize execution or decomposition.');
  if (!raw || !['KEEP', 'SPLIT'].includes(raw.action)) throw new Error('Scope action must be KEEP or SPLIT.');
  const reason = required(raw.reason, 'reason');
  const dimensions = ['execution', 'verification'] as const;
  for (const dimension of dimensions) {
    if (!['focused', 'cohesive', 'broad', 'unknown'].includes(raw[dimension]?.shape)) {
      throw new Error(`Scope decision requires the ${dimension} shape.`);
    }
    required(raw[dimension].reason, `${dimension} evidence and coupling rationale`);
  }
  if (raw.action === 'KEEP') {
    if (inventory?.strategy === 'enumerate') throw Error('An enumerated independent population requires execution tickets, not KEEP.');
    if (dimensions.some(d => raw[d].shape === 'broad')) {
      throw new Error('An independently divisible broad scope requires SPLIT, not KEEP.');
    }
    return { action: 'KEEP', reason, execution: raw.execution, verification: raw.verification, requirements: [], parts: [] };
  }
  if (!dimensions.some(d => raw[d].shape === 'broad')) throw new Error('SPLIT requires evidence of broad scope.');
  if (!Array.isArray(raw.requirements) || !raw.requirements.length) throw new Error('SPLIT needs the original requirements inventory.');
  const requirements = new Set<string>();
  for (const entry of raw.requirements) {
    const key = required(entry?.key, 'requirement key');
    required(entry?.criterion, 'original acceptance criterion');
    if (requirements.has(key)) throw new Error(`Duplicate requirement ${key}.`);
    requirements.add(key);
  }
  if (!Array.isArray(raw.parts) || raw.parts.length < 2) throw new Error('SPLIT requires at least two complete tasks.');
  const parts: ScopePart[] = raw.parts.map((p: any) => {
    const key = required(p?.key, 'part key');
    if (!Array.isArray(p.dependsOn) || !p.dependsOn.every((d: unknown) => typeof d === 'string')) {
      throw new Error(`Part ${key} requires dependency keys.`);
    }
    if (!Array.isArray(p.covers) || !p.covers.length || p.covers.some((c: unknown) => !requirements.has(c as string))) {
      throw new Error(`Part ${key} must cover known original requirements.`);
    }
    if (typeof p.integration !== 'boolean') {
      throw new Error(`Part ${key} requires an integration boolean.`);
    }
    return {
      key, dependsOn: [...new Set<string>(p.dependsOn)], covers: p.covers,
      targets: Array.isArray(p.targets) && p.targets.every((s: unknown) => typeof s === 'string') ? p.targets : [],
      workUnit: typeof p.workUnit === 'string' ? p.workUnit : '',
      integration: p.integration, handoff: required(p.handoff, `${key} progress handoff`),
      title: required(p.title, `${key} title`), description: required(p.description, `${key} description`),
      solutionVerifyPrompt: required(p.solutionVerifyPrompt, `${key} behavior checks`),
    };
  });
  const keys = new Set(parts.map(p => p.key));
  if (inventory?.strategy === 'enumerate') for (const unit of inventory.units) {
    const owners = parts.filter(p => p.workUnit === unit.key && !p.integration);
    if (owners.length !== 1 || JSON.stringify(owners[0].targets) !== JSON.stringify(unit.targets)) {
      throw Error(`Discovered unit ${unit.key} must have exactly one complete execution ticket.`);
    }
  }
  if (inventory?.strategy === 'enumerate') for (const part of parts) {
    if (part.workUnit && !inventory.units.some(unit => unit.key === part.workUnit)) {
      throw Error(`Unknown discovered work unit ${part.workUnit}.`);
    }
    if (!part.workUnit && part.targets?.length) throw Error('Unassigned setup/integration tickets cannot claim discovered targets.');
    if (part.integration && part.workUnit) throw Error('The final acceptance gate cannot replace a local execution ticket.');
  }
  if (keys.size !== parts.length) throw new Error('Duplicate split task keys.');
  for (const part of parts) for (const dep of part.dependsOn) {
    if (!keys.has(dep) || dep === part.key) throw new Error(`Invalid dependency ${dep} on ${part.key}.`);
  }
  for (const key of requirements) if (!parts.some(p => p.covers.includes(key))) {
    throw new Error(`Split drops original requirement ${key}.`);
  }
  const integrations = parts.filter(p => p.integration);
  if (integrations.length !== 1) throw new Error('SPLIT requires exactly one final integration/check task.');
  const integration = integrations[0];
  if (inventory?.strategy === 'enumerate') for (const field of ['description', 'solutionVerifyPrompt'] as const) {
    if (task[field]?.trim() && integration[field] !== task[field]) {
      throw Error(`The final acceptance gate must preserve the original ${field} unchanged.`);
    }
  }
  // The final gate follows every slice, including independent branches.
  integration.dependsOn = parts.filter(p => p !== integration).map(p => p.key);
  const ordered: ScopePart[] = [];
  const done = new Set<string>();
  while (ordered.length < parts.length) {
    const next = parts.find(p => !done.has(p.key) && p.dependsOn.every(d => done.has(d)));
    if (!next) throw new Error('Split dependency graph contains a cycle.');
    ordered.push(next); done.add(next.key);
  }
  return { action: 'SPLIT', reason, execution: raw.execution, verification: raw.verification,
    requirements: raw.requirements.map((r: any) => ({ key: r.key.trim(), criterion: r.criterion.trim() })), parts: ordered };
}

/** In-flight work may have advanced during review. Reconcile, never revert or blindly redo it. */
export function replacementTasks(assessment: ScopeAssessment, task: Task, archiveKey: string): NewTask[] {
  return assessment.parts.map(part => {
    const ticket = {
    title: part.title,
    description: `${part.description}\n\nParent acceptance criteria (${part.integration ? 'full final gate' : 'apply only to this assigned slice; sibling work is checked separately'}):\n` +
      assessment.requirements.filter(r => part.covers.includes(r.key)).map(r => `- ${r.criterion}`).join('\n') +
      `\n\nProgress-preserving handoff from task ${task.id}:\n${part.handoff}\n` +
      `Original contract, reports and journal are archived in queue metadata ${archiveKey}. ` +
      'Inspect the current workspace/diff before acting: work may have advanced since this plan. ' +
      'Retain completed changes and existing tests; implement only this slice\'s remaining work. ' +
      'Do not revert unrelated or partially finished work. A split is not proof of completion.\n' +
      `Prerequisite slices: ${part.dependsOn.join(', ') || '(none)'}.`,
    solutionVerifyPrompt: part.solutionVerifyPrompt, maxAttempts: task.maxAttempts,
    kind: 'task' as const,
    };
    // Accepted requirements belong to this scheduled outcome. Recovery may change
    // the approach, not turn a child back into its retired parent's whole job.
    const contract = { description: ticket.description,
      solutionVerifyPrompt: ticket.solutionVerifyPrompt };
    return { ...ticket, region: JSON.stringify({ scopeSplit: { archiveKey, key: part.key,
      targets: part.targets ?? [], workUnit: part.workUnit || '', integration: part.integration, contract } }) };
  });
}

/**
 * Split work forms an ordered verification barrier even in continuous mode —
 * except for a predecessor that is already terminal. A BLOCKED sibling is done
 * as far as the queue is concerned, so holding later work behind it would stall
 * the run on exactly the task a human has been asked to look at.
 */
export function scopeBlocked(task: Task, tasks: Task[]): boolean {
  return tasks.some(previous => {
    if (previous.seq >= task.seq || previous.status === 'VERIFIED' || previous.status === 'BLOCKED' ||
        previous.kind !== 'task') return false;
    try { return !!JSON.parse(previous.region || '{}').scopeSplit; } catch { return false; }
  });
}
