package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

func TestInspectionReviewerCannotOverwriteExecutorFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "test.js")
	if err := os.WriteFile(path, []byte("executor draft"), 0600); err != nil {
		t.Fatal(err)
	}
	r := tools.NewRegistry()
	tools.RegisterFS(r)
	a := New(&config.Config{InspectOnly: true}, nil, r, &tools.Env{Root: root}, func(string, any) {}, "")
	for _, def := range a.toolDefs() {
		if def.Name == "write_file" || def.Name == "edit_file" {
			t.Fatalf("advertised mutation: %s", def.Name)
		}
	}
	calls := []llm.Block{
		{Type: llm.BlockToolUse, ID: "read", Name: "read_file", Input: json.RawMessage(`{"path":"test.js"}`)},
		{Type: llm.BlockToolUse, ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"test.js","content":"supervisor rewrite"}`)},
	}
	result := a.runTools(context.Background(), "review", calls)
	if result[0].IsError || !result[1].IsError {
		t.Fatalf("read/mutation results: %+v", result)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "executor draft" {
		t.Fatalf("review overwrote executor: %q", got)
	}
	// The executor retains normal write behavior after the same read.
	a.cfg.InspectOnly = false
	if result := a.runTools(context.Background(), "executor", calls[1:]); result[0].IsError {
		t.Fatal(result)
	}
	got, _ = os.ReadFile(path)
	if string(got) != "supervisor rewrite" {
		t.Fatalf("executor write did not run: %q", got)
	}
}

func TestInspectionRejectsShellClassificationAndDirectToolBypass(t *testing.T) {
	runs := 0
	target := &tools.Tool{Name: "unix", Mutating: true, MutatesOn: func(json.RawMessage) bool { return false },
		Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result { runs++; return tools.Ok("ran") }}
	r := tools.NewRegistry()
	r.Add(target)
	a := New(&config.Config{InspectOnly: true, DisableTools: true}, nil, r, &tools.Env{Root: t.TempDir()}, func(string, any) {}, "")
	call := llm.Block{Type: llm.BlockToolUse, ID: "shell", Name: "unix", Input: json.RawMessage(`{"command":"unknown program"}`)}
	if got := a.InvokeDirectTool(context.Background(), call, target); !got.IsError {
		t.Fatal("direct invocation bypassed inspection")
	}
	if got := a.runTools(context.Background(), "review", []llm.Block{call}); !got[0].IsError {
		t.Fatal("unadvertised invocation bypassed inspection")
	}
	if runs != 0 {
		t.Fatalf("shell ran %d times", runs)
	}
}
