package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func batchEnv(t *testing.T) (*Registry, *Env, string) {
	t.Helper()
	dir := t.TempDir()
	r := NewRegistry()
	RegisterFS(r)
	RegisterShell(r)
	RegisterBatch(r)
	return r, &Env{Root: dir}, dir
}

func runBatch(t *testing.T, r *Registry, env *Env, input string) Result {
	t.Helper()
	tool, ok := r.Get("run_script")
	if !ok {
		t.Fatal("run_script is not registered")
	}
	return tool.Run(context.Background(), env, json.RawMessage(input))
}

func TestBatchReadsAndMutatesFlag(t *testing.T) {
	r, env, dir := batchEnv(t)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	readOnly := json.RawMessage(`{"steps":[{"tool":"read_file","args":{"path":"a.txt"}},{"tool":"read_file","args":{"path":"a.txt"}}]}`)
	tool, _ := r.Get("run_script")
	if tool.Mutates(readOnly) {
		t.Fatal("a batch of reads must not be reported as mutating")
	}
	res := runBatch(t, r, env, string(readOnly))
	if res.IsError {
		t.Fatalf("read batch errored: %s", res.Output)
	}
	if strings.Count(res.Output, "alpha") < 2 {
		t.Fatalf("expected both reads in output, got: %s", res.Output)
	}

	mutating := json.RawMessage(`{"steps":[{"tool":"write_file","args":{"path":"b.txt","content":"beta"}}]}`)
	if !tool.Mutates(mutating) {
		t.Fatal("a batch containing a write must be reported as mutating")
	}
}

func TestBatchSubstitutionFlowsOutput(t *testing.T) {
	r, env, dir := batchEnv(t)
	input := `{"steps":[
		{"tool":"run_shell","args":{"command":"echo BATCHTOKEN"},"save":"out"},
		{"tool":"write_file","args":{"path":"c.txt","content":"captured=${out}"}}
	]}`
	res := runBatch(t, r, env, input)
	if res.IsError {
		t.Fatalf("batch errored: %s", res.Output)
	}
	written, err := os.ReadFile(filepath.Join(dir, "c.txt"))
	if err != nil {
		t.Fatalf("write_file step did not run: %v", err)
	}
	if !strings.Contains(string(written), "BATCHTOKEN") {
		t.Fatalf("saved output was not substituted into the next step: %q", string(written))
	}
}

func TestBatchRefusesNestedAndUnknown(t *testing.T) {
	r, env, _ := batchEnv(t)

	nested := `{"steps":[{"tool":"run_script","args":{"steps":[]}},{"tool":"read_file","args":{"path":"x"}}]}`
	if res := runBatch(t, r, env, nested); !res.IsError || !strings.Contains(res.Output, "cannot contain another run_script") {
		t.Fatalf("nested run_script must be refused, got: %s (err=%v)", res.Output, res.IsError)
	}

	unknown := `{"steps":[{"tool":"does_not_exist","args":{}}]}`
	if res := runBatch(t, r, env, unknown); !res.IsError || !strings.Contains(res.Output, "unknown tool") {
		t.Fatalf("unknown tool must be refused, got: %s (err=%v)", res.Output, res.IsError)
	}
}

func TestBatchHonoursRoleAndInspectionGates(t *testing.T) {
	r, env, dir := batchEnv(t)

	// Inspection-only turns must not write through a batch.
	env.QueueRole = "executor"
	env.InspectOnly = true
	input := `{"steps":[{"tool":"write_file","args":{"path":"nope.txt","content":"x"}}]}`
	if res := runBatch(t, r, env, input); !res.IsError {
		t.Fatal("a mutating step must be refused during an inspection-only turn")
	}
	if _, err := os.Stat(filepath.Join(dir, "nope.txt")); err == nil {
		t.Fatal("the refused step must not have written a file")
	}

	// A supervisor batch must not use a writing tool either.
	env.InspectOnly = false
	env.QueueRole = "supervisor"
	if res := runBatch(t, r, env, input); !res.IsError {
		t.Fatal("a supervisor batch must not run a writing tool")
	}
}

func TestBatchStopsOnFirstErrorByDefault(t *testing.T) {
	r, env, dir := batchEnv(t)
	input := `{"steps":[
		{"tool":"read_file","args":{"path":"missing.txt"}},
		{"tool":"write_file","args":{"path":"after.txt","content":"should not exist"}}
	]}`
	res := runBatch(t, r, env, input)
	if !res.IsError {
		t.Fatal("a failing step must make the batch an error by default")
	}
	if _, err := os.Stat(filepath.Join(dir, "after.txt")); err == nil {
		t.Fatal("the step after a failure must not run when stop_on_error is true")
	}

	cont := `{"stop_on_error":false,"steps":[
		{"tool":"read_file","args":{"path":"missing.txt"}},
		{"tool":"write_file","args":{"path":"after.txt","content":"ran"}}
	]}`
	_ = runBatch(t, r, env, cont)
	if _, err := os.Stat(filepath.Join(dir, "after.txt")); err != nil {
		t.Fatal("with stop_on_error false the independent step should still run")
	}
}
