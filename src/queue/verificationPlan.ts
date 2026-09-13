import { createHash } from 'crypto';
import { extractJson } from './agentJson';
import type { Usage } from './db';

export class VerificationPlanError extends Error {
  usage?: Usage;
  validationReport?: string;
  constructor(message: string, readonly code: 'planning' | 'invalid_plan' | 'capability' | 'cancelled' | 'interaction_budget' = 'invalid_plan') {
    super(message); this.name = 'VerificationPlanError';
  }
}

export interface VerificationCapability { name: string; description: string; inputSchema?: unknown; mutating?: boolean; }
export interface VerificationStep {
  id: string;
  requirement: string;
  kind: 'shell' | 'tool';
  command?: string;
  name?: string;
  input?: Record<string, unknown>;
  expectExitCode?: number;
  expect?: { jsonEquals?: unknown; includes?: string; excludes?: string };
  dependsOn: string[];
  timeoutMs?: number;
}
export interface VerificationPlan {
  version: 1;
  reason: string;
  preservedAssertions: string[];
  steps: VerificationStep[];
  remaining: string[];
}
export interface VerificationReceipt {
  stepId: string; requirement: string; kind: 'shell' | 'tool'; name: string;
  input: Record<string, unknown>; output: string; exitCode?: number;
  passed: boolean; problem: string; truncated: boolean;
  executionSucceeded?: boolean;
  assertion?: 'passed' | 'failed' | 'unasserted' | 'invalid';
}

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => !nonempty(item))) {
    throw new VerificationPlanError(`${field} must be an explicit list of nonempty strings.`);
  }
  return value.map(item => item.trim());
}

/** Reject a whole malformed plan before any step can have side effects. */
export function parseVerificationPlan(text: string, capabilities: VerificationCapability[]): VerificationPlan {
  let value: any;
  try { value = extractJson(text); } catch { throw new VerificationPlanError('Verification planner returned no valid JSON plan.', 'planning'); }
  if (!object(value) || value.version !== 1) {
    throw new VerificationPlanError('Verification plan needs version 1.');
  }
  if (!Array.isArray(value.steps) || value.steps.length > 24) {
    throw new VerificationPlanError('A verification round accepts at most 24 steps; put unfinished checks in remaining, never truncate them.');
  }
  const names = new Set(capabilities.map(capability => capability.name));
  const ids = new Set<string>();
  const steps: VerificationStep[] = [];
  for (const raw of value.steps) {
    if (!object(raw) || !nonempty(raw.id) || ids.has(raw.id) || !nonempty(raw.requirement) || !['shell', 'tool'].includes(raw.kind)) {
      throw new VerificationPlanError('Every check needs a unique id, substantive requirement, and shell/tool kind.');
    }
    const dependsOn = strings(raw.dependsOn, `${raw.id}.dependsOn`);
    if (dependsOn.some(id => !ids.has(id))) throw new VerificationPlanError(`${raw.id} refers to an unknown or later prerequisite.`);
    const step: VerificationStep = { id: raw.id, requirement: raw.requirement, kind: raw.kind, dependsOn };
    if (raw.timeoutMs !== undefined) {
      if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1000 || raw.timeoutMs > 600000) {
        throw new VerificationPlanError(`${raw.id}.timeoutMs must be between 1000 and 600000 milliseconds.`);
      }
      step.timeoutMs = raw.timeoutMs;
    }
    if (raw.kind === 'shell') {
      if (!nonempty(raw.command) || !Number.isInteger(raw.expectExitCode) || raw.expectExitCode < 0 || raw.expectExitCode > 255) {
        throw new VerificationPlanError(`${raw.id} needs a complete shell command and expected exit code (0 through 255).`);
      }
      if (!names.has('unix')) throw new VerificationPlanError('The portable shell capability unix is unavailable.', 'capability');
      const misplaced = shellCapabilityCalls(raw.command, names);
      if (misplaced.length) throw new VerificationPlanError(`Registered tools are not shell executables: ${misplaced.join(', ')}. Use typed tool steps.`, 'capability');
      if (shellCommandWords(raw.command).some(name => /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)$/i.test(name))) {
        throw new VerificationPlanError('A typed shell step already uses the portable shell; remove host-shell wrappers.', 'capability');
      }
      if (shellCommandWords(raw.command).some(name => /^(?:Get-Command|Test-Path|Get-Content|ConvertFrom-Json|Push-Location|Pop-Location|Write-Output)$/i.test(name))) {
        throw new VerificationPlanError('PowerShell cmdlets cannot run in kind shell: verification uses the portable POSIX shell. Translate the check while preserving its assertions; executor shell feedback does not change this runtime.', 'capability');
      }
      step.command = raw.command; step.expectExitCode = raw.expectExitCode;
    } else {
      if (!nonempty(raw.name) || !names.has(raw.name)) throw new VerificationPlanError(`Unregistered verification tool: ${raw.name}.`, 'capability');
      if (['unix', 'run_shell'].includes(raw.name)) throw new VerificationPlanError('Shell invocations require kind shell and an explicit expected exit code.');
      if (/(?:^|__)(?:write_file|edit_file|multi_edit|apply_patch|delete_file)$/.test(raw.name)) {
        throw new VerificationPlanError('Verification cannot invoke production-file editing tools.');
      }
      if (!object(raw.input)) throw new VerificationPlanError(`${raw.id} requires a JSON input object matching its tool schema.`);
      validateToolInput(raw.input, capabilities.find(capability => capability.name === raw.name)?.inputSchema, raw.id);
      step.name = raw.name; step.input = raw.input;
    }
    if (raw.expect !== undefined) {
      if (!object(raw.expect) || !Object.keys(raw.expect).length || Object.keys(raw.expect).some(key => !['jsonEquals', 'includes', 'excludes'].includes(key)) ||
        ['includes', 'excludes'].some(key => key in raw.expect && !nonempty(raw.expect[key]))) {
        throw new VerificationPlanError(`${raw.id} has an invalid result assertion.`);
      }
      step.expect = raw.expect;
    }
    ids.add(step.id); steps.push(step);
  }
  const remaining = strings(value.remaining, 'remaining');
  if (!steps.length && !remaining.length) throw new VerificationPlanError('An empty plan cannot establish verification.');
  const preservedAssertions = strings(value.preservedAssertions, 'preservedAssertions');
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  return { version: 1, reason, preservedAssertions, steps, remaining };
}

/** Enforce the registry's structural schema before invoking any capability. */
function validateToolInput(input: unknown, schema: any, path: string): void {
  if (!object(schema)) return;
  const fail = (detail: string): never => { throw new VerificationPlanError(`${path}: ${detail}`, 'capability'); };
  const matchesType = (type: string) => type === 'object' ? object(input) : type === 'array' ? Array.isArray(input) :
    type === 'integer' ? Number.isInteger(input) : type === 'null' ? input === null : typeof input === type;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(matchesType)) fail(`input does not match type ${types.join('|')}.`);
  if (Array.isArray(schema.enum) && !schema.enum.some((value: unknown) => JSON.stringify(value) === JSON.stringify(input))) fail('value is not in the registered enum.');
  if (object(input)) {
    if (Array.isArray(schema.required)) for (const key of schema.required) if (!(key in input)) fail(`required field ${key} is missing.`);
    for (const [key, value] of Object.entries(input)) {
      if (schema.additionalProperties === false && !(key in (schema.properties || {}))) fail(`field ${key} is not registered.`);
      if (schema.properties?.[key]) validateToolInput(value, schema.properties[key], `${path}.${key}`);
    }
  }
  if (Array.isArray(input) && schema.items) input.forEach((value, index) => validateToolInput(value, schema.items, `${path}[${index}]`));
}

/** Inspect command positions, never quoted evidence/arguments, for RPC/shell confusion. */
export function shellCapabilityCalls(command: string, names: Set<string>): string[] {
  return shellCommandWords(command).filter(word => names.has(word) && word.includes('_') && word !== 'run_shell');
}

function shellCommandWords(command: string): string[] {
  let quote = '', escaped = false, word = '', atCommand = true;
  const found = new Set<string>();
  const flush = () => {
    if (!word) return;
    if (atCommand) found.add(word);
    if (atCommand && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) &&
      !['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!'].includes(word)) atCommand = false;
    word = '';
  };
  for (const char of command) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (';&|()\n'.includes(char)) { flush(); atCommand = true; }
    else if (/\s/.test(char)) flush();
    else word += char;
  }
  flush();
  return [...found];
}

/** Arguments and expectations, not renamed check IDs, define an invocation. */
export function verificationInvocation(step: VerificationStep): string {
  return createHash('sha256').update(JSON.stringify(stable([step.kind, step.command, step.name, step.input]))).digest('hex');
}

function stable(value: any): any {
  return Array.isArray(value) ? value.map(stable) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}

export function verificationReceipt(step: VerificationStep, result: { output: string; isError: boolean; meta?: any }): VerificationReceipt {
  const output = String(result.output ?? '');
  const exitCode = Number.isInteger(result.meta?.exitCode) ? result.meta.exitCode : undefined;
  const invocationFailure = step.kind === 'shell' && (exitCode === 126 || exitCode === 127 ||
    result.isError && exitCode === 0 ||
    result.isError && /(?:command not found|not recognized as|not recognized as an internal|executable file not found|no such command|parse error:|script timed out|cannot find (?:the )?(?:file|path))/i.test(output));
  let problem = '';
  let invalidAssertion = false;
  if (step.kind === 'shell') {
    if (exitCode === undefined) problem = 'The shell supplied no reliable exit code; this is not a passing check.';
    else if (invocationFailure) problem = 'The shell reported an invocation failure, not an observed negative assertion.';
    else if (exitCode !== step.expectExitCode) problem = `Expected exit ${step.expectExitCode}; observed ${exitCode}.`;
  } else if (result.isError) problem = 'The registered tool reported an execution error.';
  if (step.expect && !problem) {
    if ('jsonEquals' in step.expect) {
      try {
        if (JSON.stringify(stable(JSON.parse(output))) !== JSON.stringify(stable(step.expect.jsonEquals))) problem = 'Observed JSON does not equal the expected value.';
      } catch {
        invalidAssertion = true;
        problem = 'Expected a JSON result, but the tool did not return valid JSON.';
      }
    }
    if (step.expect.includes && !output.includes(step.expect.includes)) problem = 'Required output text was not observed.';
    if (step.expect.excludes && output.includes(step.expect.excludes)) problem = 'Forbidden output text was observed.';
  }
  const asserted = step.kind === 'shell' || !!step.expect;
  return { stepId: step.id, requirement: step.requirement, kind: step.kind,
    name: step.kind === 'shell' ? 'unix' : step.name!,
    input: step.kind === 'shell' ? { command: step.command! } : step.input!,
    output: output.slice(0, 12000), exitCode, passed: !problem, problem, truncated: output.length > 12000,
    executionSucceeded: step.kind === 'shell' ? exitCode !== undefined && !invocationFailure : !result.isError,
    assertion: asserted ? invalidAssertion ? 'invalid' : problem ? 'failed' : 'passed' : 'unasserted' };
}
