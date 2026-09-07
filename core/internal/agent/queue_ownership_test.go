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

func TestExecutorCannotRewriteTestsOrTaskQueueButSupervisorCanRepairTests(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "form.spec.js")
	if err := os.WriteFile(file, []byte("broken test"), 0600); err != nil {
		t.Fatal(err)
	}
	registry := tools.NewRegistry()
	tools.RegisterFS(registry)
	queueWrites := 0
	queueTool := &tools.Tool{Name: "mcp__mfagent__task_queue_update", Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
		queueWrites++
		return tools.Ok("changed")
	}}
	registry.Add(queueTool)
	executor := New(&config.Config{QueueRole: "executor"}, nil, registry, &tools.Env{Root: root}, func(string, any) {}, "")
	calls := []llm.Block{
		{Type: llm.BlockToolUse, ID: "read", Name: "read_file", Input: json.RawMessage(`{"path":"form.spec.js"}`)},
		{Type: llm.BlockToolUse, ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"form.spec.js","content":"repaired test"}`)},
	}
	result := executor.runTools(context.Background(), "executor", calls)
	if result[0].IsError || !result[1].IsError {
		t.Fatalf("executor read/write: %+v", result)
	}
	if got := executor.InvokeDirectTool(context.Background(), llm.Block{Name: queueTool.Name, Input: json.RawMessage(`{"id":29,"description":"easier task"}`)}, queueTool); !got.IsError {
		t.Fatal("direct queue write allowed")
	}
	for _, def := range executor.toolDefs() {
		if def.Name == queueTool.Name {
			t.Fatal("queue write advertised to executor")
		}
	}
	if queueWrites != 0 {
		t.Fatal("queue mutation executed")
	}
	supervisor := New(&config.Config{QueueRole: "supervisor-repair", InspectOnly: false}, nil, registry, &tools.Env{Root: root}, func(string, any) {}, "")
	result = supervisor.runTools(context.Background(), "supervisor-repair", calls)
	if result[0].IsError || result[1].IsError {
		t.Fatalf("supervisor repair rejected: %+v", result)
	}
	data, _ := os.ReadFile(file)
	if string(data) != "repaired test" {
		t.Fatal("repair did not land")
	}
}

func TestExecutorQueueAndTestShellBypassesAreRejected(t *testing.T) {
	e := &tools.Env{Root: t.TempDir(), QueueRole: "executor"}
	for _, cmd := range []string{"sqlite3 .mfagent/queue.db 'update tasks set description=1'", "mfagent.queue.splitTask", "python -c 'rewrite' form.spec.js", "echo weakened > tests/form.js"} {
		if e.CheckQueueCommand(cmd) == nil {
			t.Fatalf("accepted %s", cmd)
		}
	}
	for _, cmd := range []string{"node --check form.spec.js", "npx playwright test form.spec.js --grep navigation", "npm run build"} {
		if err := e.CheckQueueCommand(cmd); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReviewRolesCannotRewriteProductionAndValidatorCannotRewriteTests(t *testing.T) {
	root := t.TempDir()
	registry := tools.NewRegistry()
	tools.RegisterFS(registry)
	for _, role := range []string{"validator", "supervisor", "supervisor-repair"} {
		a := New(&config.Config{QueueRole: role}, nil, registry, &tools.Env{Root: root}, func(string, any) {}, "")
		calls := []llm.Block{{Type: llm.BlockToolUse, ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"app.js","content":"weakened implementation"}`)}}
		if !a.runTools(context.Background(), role, calls)[0].IsError {
			t.Fatalf("%s rewrote production", role)
		}
		if role != "supervisor-repair" {
			calls[0].Input = json.RawMessage(`{"path":"new.spec.js","content":"fake passing test"}`)
			if !a.runTools(context.Background(), role, calls)[0].IsError {
				t.Fatalf("%s wrote a new test", role)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(root, "app.js")); !os.IsNotExist(err) {
		t.Fatal("production write landed")
	}
}

func TestQueueOwnershipCoversPatchesAndExpandedRedirections(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "form.spec.js")
	if err := os.WriteFile(file, []byte("original assertion"), 0600); err != nil {
		t.Fatal(err)
	}
	e := &tools.Env{Root: root, QueueRole: "executor"}
	patch, _ := json.Marshal(map[string]string{"patch": "*** Begin Patch\n*** Update File: form.spec.js\n@@\n-original assertion\n+fake pass\n*** End Patch"})
	if e.CheckQueueOwnership("apply_patch", patch, true) == nil {
		t.Fatal("patch bypass allowed")
	}
	if _, code, err := tools.RunScript(context.Background(), e, root, `target=form.spec.js; printf fake > "$target"`); code == 0 && err == nil {
		t.Fatal("expanded redirection bypass allowed")
	}
	data, _ := os.ReadFile(file)
	if string(data) != "original assertion" {
		t.Fatal("protected test changed")
	}
	for _, role := range []string{"validator", "supervisor-repair"} {
		e.QueueRole = role
		if e.CheckQueueCommand(`node -e "require('fs').writeFileSync('app.js','bad')"`) == nil {
			t.Fatal("inline writer allowed")
		}
		if err := e.CheckQueueCommand("npx playwright test form.spec.js"); err != nil {
			t.Fatal(err)
		}
	}
}
