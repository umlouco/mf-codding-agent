import * as vscode from 'vscode';
import { ModelRegistry } from './models';
import { ProfileStore } from './store';

/**
 * Process-wide handles to the profile store and the model registry.
 *
 * Both are created once in `activate` and read from all over — the core client,
 * the queue's ephemeral agents, the settings page. Threading them through every
 * constructor would add a parameter to code that has no other reason to know
 * about them, so they live here behind an explicit init.
 */

let store: ProfileStore | undefined;
let registry: ModelRegistry | undefined;
let extContext: vscode.ExtensionContext | undefined;

export function initProviders(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): { store: ProfileStore; models: ModelRegistry } {
  store = new ProfileStore(context);
  registry = new ModelRegistry(context, output);
  extContext = context;
  context.subscriptions.push({ dispose: () => store?.dispose() });
  return { store, models: registry };
}

export function getContext(): vscode.ExtensionContext {
  if (!extContext) {
    throw new Error('MF Agent: the extension context was read before activation finished.');
  }
  return extContext;
}

export function getStore(): ProfileStore {
  if (!store) {
    throw new Error('MF Agent: the provider store was read before activation finished.');
  }
  return store;
}

export function getModelRegistry(): ModelRegistry {
  if (!registry) {
    throw new Error('MF Agent: the model registry was read before activation finished.');
  }
  return registry;
}
