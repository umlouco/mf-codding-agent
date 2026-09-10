import * as path from 'path';
import * as vscode from 'vscode';
import { CoreClient } from './core';
import { matchEdits, replaceIn } from './textEdits';

/**
 * Applies the core's file-mutation tools (write_file, edit_file, multi_edit)
 * through VS Code's own document/edit APIs, instead of the raw OS read/write
 * the core falls back to when nothing is listening — see Env.EditorWrite /
 * Env.EditorEdit in core/internal/tools/registry.go.
 *
 * The point is not speed, it is correctness. A raw `os.WriteFile` from a
 * separate process has no idea a file is open with unsaved changes in the
 * editor: it clobbers the bytes on disk underneath the buffer, and the next
 * time the user saves, their stale buffer overwrites the agent's work with no
 * warning. Routing through `vscode.workspace.applyEdit` fixes that at the
 * root — the edit is computed and applied against whatever is actually live
 * for that file, open or not, so it merges with unsaved changes instead of
 * racing them, and it lands on VS Code's own undo stack for free.
 *
 * Every path here ends with the document saved. Every other tool the core
 * has (grep, read_file, shell commands, verification commands) still reads
 * and writes the workspace directly, so disk has to stay the single source
 * of truth the instant a tool call returns — nothing here may leave a change
 * sitting only in an in-memory buffer.
 */

interface EditParam {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Registers the `fs/write` and `fs/edit` handlers a core process calls back
 * into. Call once per CoreClient, right after constructing it. */
export function registerEditorFsHandlers(client: CoreClient): void {
  client.onRequest('fs/write', async (params) => handleWrite(params));
  client.onRequest('fs/edit', async (params) => handleEdit(params));
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findOpenDocument(absPath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, absPath),
  );
}

function fullRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
}

/** Applies `edit` and saves — the one path every handler below funnels through,
 * so "the write landed on disk" is never optional. */
async function commit(document: vscode.TextDocument, absPath: string, edit: vscode.WorkspaceEdit): Promise<void> {
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(`VS Code declined to apply the edit to ${absPath}`);
  }
  await document.save();
}

async function handleWrite(params: { path: string; content: string }): Promise<{ ok: true }> {
  const abs = params.path;
  const uri = vscode.Uri.file(abs);

  const open = findOpenDocument(abs);
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange(open), params.content);
    await commit(open, abs, edit);
    return { ok: true };
  }

  // Nothing has it open — a plain native write is enough, and it avoids
  // pulling a document into memory that nobody asked to look at.
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(abs)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, 'utf8'));
  return { ok: true };
}

async function handleEdit(params: { path: string; edits: EditParam[] }): Promise<{ replacements: number }> {
  const abs = params.path;
  const uri = vscode.Uri.file(abs);
  // Existence is already guaranteed by the core's own read-before-edit check,
  // so this transparently picks up whatever is actually live: the open
  // buffer if there is one (dirty or not), disk otherwise.
  const document = await vscode.workspace.openTextDocument(uri);
  const original = document.getText();

  if (params.edits.length === 1) {
    const e = params.edits[0];
    const matches = matchEdits(original, e.old_string, e.new_string, !!e.replace_all);
    const edit = new vscode.WorkspaceEdit();
    for (const match of matches) {
      const range = new vscode.Range(
        document.positionAt(match.start),
        document.positionAt(match.end),
      );
      edit.replace(uri, range, match.replacement);
    }
    await commit(document, abs, edit);
    return { replacements: matches.length };
  }

  // Several edits in one call: fold sequentially over the text, exactly
  // mirroring multi_edit's own semantics in fs.go (each edit sees the result
  // of the one before it, and any failure aborts the whole batch before
  // anything is written) — then land the result as one WorkspaceEdit, so it
  // is still a single native, single-undo-step write rather than several
  // that could each partially apply.
  let text = original;
  let total = 0;
  for (const e of params.edits) {
    const r = replaceIn(text, e.old_string, e.new_string, !!e.replace_all);
    text = r.text;
    total += r.count;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, fullRange(document), text);
  await commit(document, abs, edit);
  return { replacements: total };
}
