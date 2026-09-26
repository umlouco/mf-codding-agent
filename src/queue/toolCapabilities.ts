import type * as vscode from 'vscode';
import { CoreClient } from '../core';
import { registerEditorFsHandlers } from '../editorFs';
import { getBridge } from '../mcpBridge';
import type { ActivityRecord } from './agentTypes';

/**
 * The core's real tool registry, read without starting a model loop.
 *
 * A response-only recovery decision has no callable tools, so it is given the
 * executor's actual tool names and input schemas as data, and any next step it
 * proposes is validated against them instead of trusting a name from prose.
 */

export class ToolCapabilityError extends Error {
  constructor(message: string, readonly code: 'capability' | 'cancelled' = 'capability') {
    super(message);
    this.name = 'ToolCapabilityError';
  }
}

export interface ToolCapability { name: string; description: string; inputSchema?: unknown; mutating?: boolean; }

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Enforce the registry's structural schema before invoking any capability. */
export function validateToolInput(input: unknown, schema: any, path: string): void {
  if (!object(schema)) return;
  const fail = (detail: string): never => { throw new ToolCapabilityError(`${path}: ${detail}`); };
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

/** One short-lived tool process that lists the registry and can invoke tools directly. */
export class ToolRegistry {
  readonly client: CoreClient;
  private cancelled = false;
  capabilities: ToolCapability[] = [];

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel,
    private readonly onActivity?: (activity: ActivityRecord) => void) {
    this.client = new CoreClient(context, output);
    registerEditorFsHandlers(this.client);
    getBridge().attach(this.client);
  }

  async start(): Promise<void> {
    this.checkActive();
    this.onActivity?.({ phase: 'tool', detail: 'reading the executor tool registry', at: Date.now() });
    await this.client.start();
    this.checkActive();
    await this.client.initialize({ disableTools: true, editorTerminal: false, memoryEnabled: false, queueRole: 'validator' });
    this.checkActive();
    const listed = await this.client.request<ToolCapability[]>('tools/list');
    this.checkActive();
    if (!Array.isArray(listed) || listed.some(tool => typeof tool.name !== 'string' || typeof tool.description !== 'string')) {
      throw new ToolCapabilityError('The core returned no usable tool registry.');
    }
    this.capabilities = listed;
  }

  stop(): void { this.cancelled = true; this.client.dispose(); }

  private checkActive(): void {
    if (this.cancelled) throw new ToolCapabilityError('Cancelled before the tool registry was read.', 'cancelled');
  }
}
