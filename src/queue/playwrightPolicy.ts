import type { TaskQueue } from './db';
import type { VerificationPlan } from './verificationPlan';

type TestingSettings = Pick<TaskQueue, 'testingUrl' | 'testingCredentialNames'>;
const enforced = new WeakSet<VerificationPlan>();
const mandatorySteps = new WeakSet<object>();
export function isMandatoryPlaywrightStep(step: object): boolean { return mandatorySteps.has(step); }

export function requiresPlaywright(queue?: TestingSettings): boolean {
  return !!queue?.testingUrl && queue.testingCredentialNames.length > 0;
}

/** Mandatory host check; independent of task text and the model's selected tools. */
export function enforcePlaywright(plan: VerificationPlan, queue?: TestingSettings): VerificationPlan {
  if (!requiresPlaywright(queue) || enforced.has(plan)) return plan;
  let id = 'host-required-playwright';
  while (plan.steps.some(step => step.id === id)) id += '-host';
  const step = { id, requirement: 'Run Playwright against the owner-configured URL with configured credentials.',
    kind: 'tool' as const, name: 'playwright_test', input: {}, dependsOn: [], timeoutMs: 540000 };
  const result = { ...plan, steps: [...plan.steps, step] };
  mandatorySteps.add(step);
  enforced.add(result);
  return result;
}
