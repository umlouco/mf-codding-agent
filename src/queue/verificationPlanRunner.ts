import type * as vscode from 'vscode';
import { CoreClient } from '../core';
import { registerEditorFsHandlers } from '../editorFs';
import { getBridge } from '../mcpBridge';
import type { ActivityRecord } from './agentTypes';
import type { Usage } from './db';
import { getActiveQueue } from './registry';
import { loadTestingEnvironment, redactTestingSecrets, TestingEnvironment } from './testingEnvironment';
import { enforcePlaywright, isMandatoryPlaywrightStep } from './playwrightPolicy';
import { VerificationCapability, VerificationPlan, VerificationPlanError, VerificationReceipt,
  verificationInvocation, verificationReceipt } from './verificationPlan';

/** One owned tool process keeps browser state between typed steps. It never calls chat/send. */
export class VerificationSession {
  private readonly client: CoreClient;
  private cancelled = false;
  private unavailable = false;
  private testing?: TestingEnvironment;
  private mandatoryReceipt?: VerificationReceipt;
  capabilities: VerificationCapability[] = [];
  /** Keep partial receipts if the next model-backed check cannot be admitted. */
  receipts: VerificationReceipt[] = [];
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel,
    private readonly onEvent: (method: string, params: any) => void,
    private readonly onActivity?: (activity: ActivityRecord) => void,
    private readonly beforeModel?: (stage: string) => void) {
    this.client = new CoreClient(context, output);
    registerEditorFsHandlers(this.client);
    getBridge().attach(this.client);
  }

  async start(context: vscode.ExtensionContext): Promise<void> {
    this.checkActive();
    const queue = getActiveQueue?.();
    this.testing = queue ? await loadTestingEnvironment(context, queue) : undefined;
    this.checkActive();
    this.activity('initializing isolated verification tools');
    await this.client.start();
    this.checkActive();
    // inspectOnly forbids browser navigation and tests; disableTools prevents a
    // model loop here, while direct typed calls retain the core's tool safeguards.
    await this.client.initialize({ disableTools: true, editorTerminal: false, memoryEnabled: false, queueRole: 'validator' });
    this.checkActive();
    const listed = await this.client.request<VerificationCapability[]>('tools/list');
    this.checkActive();
    if (!Array.isArray(listed) || listed.some(tool => typeof tool.name !== 'string' || typeof tool.description !== 'string')) {
      throw new VerificationPlanError('The core returned no usable verification capability registry.', 'capability');
    }
    this.capabilities = listed;
  }

  async execute(plan: VerificationPlan): Promise<VerificationReceipt[]> {
    plan = this.requiredPlan(plan);
    const receipts = this.receipts = [] as VerificationReceipt[];
    const failedInvocations = new Set<string>();
    for (const step of plan.steps) {
      this.checkActive();
      if (isMandatoryPlaywrightStep(step) && this.mandatoryReceipt) {
        receipts.push({ ...this.mandatoryReceipt, stepId: step.id, requirement: step.requirement });
        continue;
      }
      const name = step.kind === 'shell' ? 'unix' : step.name!;
      const waitsForModel = name === 'browser_layout_check' || name === 'playwright_layout_check';
      const timeoutMs = step.timeoutMs ?? 120000;
      const input = step.kind === 'shell' ? { command: step.command!, timeout_ms: timeoutMs } : step.input!;
      const fingerprint = verificationInvocation(step);
      const unmet = step.dependsOn.find(id => !receipts.find(receipt => receipt.stepId === id)?.passed);
      if (this.unavailable || unmet || failedInvocations.has(fingerprint)) {
        receipts.push({ stepId: step.id, requirement: step.requirement, kind: step.kind, name, input,
          output: '', passed: false, truncated: false, problem: this.unavailable
            ? 'Not executed: the owned tool process exceeded its step deadline.' : unmet
            ? `Not executed: prerequisite ${unmet} did not pass.`
            : 'Not executed: this exact invocation already failed; repeating it is not new evidence.' });
        continue;
      }
      const id = `verification-${Date.now()}-${step.id}`;
      if (waitsForModel) this.beforeModel?.(`vision: ${name}`);
      this.activity(`verification check ${step.id}: ${step.requirement}`);
      this.emit('stream/tool', { id, name, status: 'running', input });
      const timer = setInterval(() => this.activity(`verification check ${step.id} is awaiting its tool result`), 5000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.client.request<{ output: string; isError: boolean; meta?: any; usage?: Usage }>('tools/invoke', { name, input }),
          new Promise<never>((_, reject) => {
            // Capture operations have their own bounds; the following vision model wait does not.
            if (waitsForModel) return;
            deadline = setTimeout(() => {
            this.unavailable = true;
            this.client.dispose();
            reject(new VerificationPlanError(`Tool ${name} exceeded its ${timeoutMs}ms verification deadline.`, 'capability'));
          }, timeoutMs); }),
        ]);
        this.checkActive();
        if (!result || typeof result.output !== 'string' || typeof result.isError !== 'boolean') {
          throw new VerificationPlanError(`Tool ${name} returned no trustworthy execution result.`, 'capability');
        }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
          const count = result.usage?.[key];
          if (typeof count === 'number' && Number.isFinite(count) && count > 0) this.usage[key] += count;
        }
        const observed = { ...result, output: redactTestingSecrets(result.output, this.testing) };
        const receipt = verificationReceipt(step, observed);
        this.emit('stream/tool', { id, name, status: receipt.passed ? 'ok' : 'error', output: observed.output,
          meta: { ...result.meta, toolIsError: result.isError, expectedExitCode: step.expectExitCode, assertionProblem: receipt.problem } });
        if (!receipt.passed) failedInvocations.add(fingerprint);
        if (isMandatoryPlaywrightStep(step)) this.mandatoryReceipt = receipt;
        receipts.push(receipt);
      } catch (error: any) {
        this.checkActive();
        const problem = redactTestingSecrets(String(error?.message ?? error), this.testing);
        this.emit('stream/tool', { id, name, status: 'error', output: problem });
        failedInvocations.add(fingerprint);
        receipts.push({ stepId: step.id, requirement: step.requirement, kind: step.kind, name, input,
          output: problem, passed: false, truncated: false, problem });
      } finally { clearInterval(timer); if (deadline) clearTimeout(deadline); }
    }
    return receipts;
  }

  requiredPlan(plan: VerificationPlan): VerificationPlan {
    return enforcePlaywright(plan, this.testing ? {
      testingUrl: this.testing.url, testingCredentialNames: Object.keys(this.testing.credentials),
    } : undefined);
  }

  stop(): void { this.cancelled = true; this.client.dispose(); }
  private checkActive(): void {
    if (this.cancelled) throw new VerificationPlanError('Verification cancelled; no later steps were executed.', 'cancelled');
  }
  private activity(detail: string): void {
    if (!this.cancelled) this.onActivity?.({ phase: 'tool', detail, at: Date.now() });
  }
  private emit(method: string, params: any): void {
    if (this.cancelled) return;
    const redacted = JSON.parse(redactTestingSecrets(JSON.stringify(params), this.testing));
    this.onEvent(method, redacted);
  }
}
