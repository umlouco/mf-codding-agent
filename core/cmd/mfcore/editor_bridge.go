package main

import (
	"context"

	"github.com/mflores/mfagent/core/internal/tools"
)

// ---- editor-side file writes --------------------------------------------
//
// These hand the actual mutation to the extension instead of touching the
// file directly — see Env.EditorWrite / Env.EditorEdit and src/editorFs.ts.
// The point is not speed, it is correctness: the extension applies the
// change through vscode.workspace.applyEdit against whatever is actually
// live for that file (an open, possibly unsaved buffer, or disk if nothing
// has it open), so an edit can never silently overwrite work the user has
// not saved yet, and it participates in VS Code's own undo stack. It always
// ends with the document saved, so every other tool — which still reads and
// writes the workspace directly — keeps seeing disk as the single source of
// truth.

func (s *server) editorWrite(ctx context.Context, path, content string) error {
	var reply struct {
		OK bool `json:"ok"`
	}
	return s.conn.Call(ctx, "fs/write", map[string]any{
		"path": path, "content": content,
	}, &reply)
}

// editorTerminal asks the extension to run a command in a real VS Code
// terminal — see Env.EditorTerminal and src/editorTerminal.ts. It is wired in
// only when the extension announced that it has shell integration to offer, so
// a nil hook and a failed call mean different things: nil is "no terminal
// available, spawn it yourself", an error is "the terminal tried and could not".
func (s *server) editorTerminal(ctx context.Context, cwd, command string, timeoutMS int) (tools.TerminalRun, error) {
	var reply struct {
		Output   string `json:"output"`
		ExitCode *int   `json:"exitCode"`
		TimedOut bool   `json:"timedOut"`
	}
	if err := s.conn.Call(ctx, "shell/exec", map[string]any{
		"cwd": cwd, "command": command, "timeoutMs": timeoutMS,
	}, &reply); err != nil {
		return tools.TerminalRun{}, err
	}
	return tools.TerminalRun{
		Output: reply.Output, ExitCode: reply.ExitCode, TimedOut: reply.TimedOut,
	}, nil
}

func (s *server) editorEdit(ctx context.Context, path string, edits []tools.EditOp) (int, error) {
	type editParam struct {
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all"`
	}
	params := make([]editParam, len(edits))
	for i, e := range edits {
		params[i] = editParam{OldString: e.OldString, NewString: e.NewString, ReplaceAll: e.ReplaceAll}
	}
	var reply struct {
		Replacements int `json:"replacements"`
	}
	if err := s.conn.Call(ctx, "fs/edit", map[string]any{
		"path": path, "edits": params,
	}, &reply); err != nil {
		return 0, err
	}
	return reply.Replacements, nil
}
