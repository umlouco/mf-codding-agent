import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveMcpBinary } from './detect';

/** Must match the `mcpServerDefinitionProviders` entry in package.json. */
export const MCP_PROVIDER_ID = 'mf-agent.mcp-servers';
export const MCP_SERVER_LABEL = 'MF Agent Task Queue';
export const MCP_SERVER_NAME = 'mfagent-task-queue';

/**
 * Makes the task-queue MCP server visible to VS Code's native MCP system: the
 * Extensions view "MCP SERVERS" list, GitHub Copilot Chat, and any extension
 * that reads the editor's MCP registry. This is the mechanism the VS Code
 * "MCP developer guide" prescribes for extensions.
 *
 * Standalone tools (Claude Code, Cursor, etc.) do not read VS Code's registry,
 * so they are covered separately by a project-root `.mcp.json` — see
 * `writeProjectMcpJson`.
 *
 * `registerMcpServerDefinitionProvider` shipped in VS Code 1.99; on older
 * editors the whole registration is skipped and only the JSON-based paths
 * remain.
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
  const register = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof register !== 'function') {
    return;
  }

  context.subscriptions.push(
    register(MCP_PROVIDER_ID, {
      provideMcpServerDefinitions: (): vscode.McpServerDefinition[] => {
        const bin = resolveMcpBinary(context);
        if (!bin) {
          return [];
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const def = new vscode.McpStdioServerDefinition(
          MCP_SERVER_LABEL,
          bin,
          root ? ['--workspace', root] : [],
          undefined,
          '0.1.0',
        );
        if (root) {
          def.cwd = vscode.Uri.file(root);
        }
        return [def];
      },
    }),
  );
}

/**
 * Writes (or merges into) the workspace-root `.mcp.json`. This is the file
 * Claude Code, Cursor and the VS Code Agent Host read natively for MCP
 * configuration, so a single write covers every JSON-configured client.
 * Existing servers and unrelated top-level keys are preserved.
 */
export function writeProjectMcpJson(root: string, bin: string): string {
  const file = path.join(root, '.mcp.json');

  let doc: any = {};
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      doc = {};
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    doc = {};
  }

  const servers =
    doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
      ? doc.mcpServers
      : {};
  servers[MCP_SERVER_NAME] = {
    type: 'stdio',
    command: bin,
    args: ['--workspace', root],
  };
  doc.mcpServers = servers;

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}
