import type { Task } from './db';
import type { ScopeAssessment, ScopePart } from './scopePlan';
import type { WorkInventory } from './workInventory';

/** Expand discovered units into execution tickets, without asking a model to
 * re-author the original requirements N times. The final gate retains them intact.
 */
export function inventoryScopePlan(task: Task, inventory: WorkInventory): ScopeAssessment {
  if (inventory.strategy !== 'enumerate') throw Error('An enumerated work population is required.');
  const part = (key: string, title: string, description: string, targets: string[], dependsOn: string[], workUnit = ''): ScopePart => ({
    key, title, description, targets, workUnit, dependsOn, integration: false, covers: ['original-work'],
    handoff: `Preserve existing changes and tests. Previous executor handoff (claim, not proof):\n${task.output?.slice(-4000) || '(none)'}\n` +
      'Determine what is already complete before editing; verify completed work instead of repeating it.',
    solutionVerifyPrompt: 'Verify this execution ticket against every applicable behavior in the unchanged parent contract ' +
      'using the owner-supplied runtime and test requirements. Record concrete observations and commands. ' +
      'Prerequisites must be available; not-yet-executed independent tickets are not failures of this ticket. ' +
      'Do not claim the whole objective is complete from a local check.',
  });
  const setup = part('prerequisites', 'Establish shared prerequisites for discovered work',
    'Inspect the original contract and existing changes. Establish only shared prerequisites needed by the discovered ' +
    'execution tickets. If already available, verify and retain them. Do not perform the independent tickets here or remove ' +
    'compatibility needed by unfinished consumers. Discover supporting commands and dependencies rather than inventing them.', [], []);
  const slices = inventory.units.map(unit => part(unit.key, `Complete: ${unit.label}`,
    `Execute the unchanged parent request for this discovered work unit: ${unit.label}.\n` +
    `Population rationale: ${inventory.collections.find(c => c.key === unit.collection)?.reason}\n` +
    'Apply all relevant original requirements. Inspect existing work first; implement only what remains, or perform focused ' +
    'verification if it is already implemented. Supporting changes are allowed when necessary for this outcome. ' +
    'Other independently inventoried units have separate tickets, not reduced acceptance criteria.', unit.targets, [setup.key], unit.key));
  const integration: ScopePart = {
    key: 'integration', title: `Final acceptance: ${task.title}`, integration: true, targets: [],
    dependsOn: [setup.key, ...slices.map(p => p.key)], covers: ['original-work', 'original-behavior'],
    description: task.description,
    handoff: 'Reconcile every ticket and its evidence, finish cross-unit integration and cleanup, then check the original contract. ' +
      'The original request and checks are unchanged. Do not repeat all local inspections if current verified evidence suffices.',
    solutionVerifyPrompt: task.solutionVerifyPrompt || 'Verify the complete original behavior contract.',
  };
  return { action: 'SPLIT', reason: inventory.reason,
    execution: { shape: 'broad', reason: 'Discovery identified independent work units with complete host-expanded membership.' },
    verification: { shape: 'broad', reason: 'Local evidence per unit precedes the unchanged final acceptance gate.' },
    requirements: [
      { key: 'original-work', criterion: task.description },
      { key: 'original-behavior', criterion: task.solutionVerifyPrompt || 'Meet the original behavior requirements.' },
    ], parts: [setup, ...slices, integration] };
}

export function scopeBoundary(task: Task): string {
  try {
    const split = JSON.parse(task.region || '{}').scopeSplit;
    if (!split) return '';
    const { contract: _contract, ...identity } = split;
    return `PERSISTED EXECUTION TICKET: ${JSON.stringify(identity)}\n` +
      'The original objective and acceptance criteria are unchanged. Work is scheduled across dependency-ordered tickets ' +
      'and an unchanged final acceptance gate. Judge this ticket against its assigned outcome; missing future independent ' +
      'work is not a defect in this ticket. Do not expand every ticket back into the entire objective. ' +
      (split.integration ? 'This is the final acceptance gate: reconcile already verified children and check cross-slice behavior. ' +
        'The original implementation population was already decomposed. Do not recreate it from the breadth of the retained acceptance criteria.' :
        'This local contract is committed. Recovery may change implementation approach or test invocation through guidance, ' +
        'not rewrite acceptance criteria. Parent criteria constrain this assigned slice; they do not transfer sibling ownership to it.');
  } catch { return ''; }
}

export function boundedTask(task: Task): Task {
  const boundary = scopeBoundary(task);
  return boundary ? { ...task, description: `${task.description}\n\n${boundary}` } : task;
}
