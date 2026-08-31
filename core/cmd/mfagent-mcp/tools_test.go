package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/mflores/mfagent/core/internal/queue"
)

func testServer(t *testing.T) *server {
	t.Helper()
	db, err := queue.Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatalf("open queue: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	s := &server{db: db}
	s.registerTools()
	return s
}

func validPlan(dryRun bool, mode string) []byte {
	in := map[string]any{
		"goal":   "Add reliable invoice export",
		"mode":   mode,
		"dryRun": dryRun,
		"tasks": []map[string]any{{
			"title":               "Implement invoice export",
			"description":         "Add the export service and wire it to the existing invoice API endpoint.",
			"implementationCheck": "Inspect the service and endpoint integration in the final diff.",
			"behaviorCheck":       "Exercise a successful export and the invalid invoice error path.",
			"verificationCommand": "npm test -- invoice-export",
		}},
	}
	b, _ := json.Marshal(in)
	return b
}

func TestWritePlanDryRunAndPersistedChecks(t *testing.T) {
	s := testServer(t)
	text, isError, err := s.onWritePlan(context.Background(), validPlan(true, "replace"))
	if err != nil || isError {
		t.Fatalf("dry run: text=%s isError=%v err=%v", text, isError, err)
	}
	tasks, _ := queue.ListTasks(s.db)
	if len(tasks) != 0 {
		t.Fatalf("dry run wrote %d tasks", len(tasks))
	}

	text, isError, err = s.onWritePlan(context.Background(), validPlan(false, "replace"))
	if err != nil || isError {
		t.Fatalf("write: text=%s isError=%v err=%v", text, isError, err)
	}
	tasks, err = queue.ListTasks(s.db)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("list: tasks=%d err=%v", len(tasks), err)
	}
	got := tasks[0]
	if got.ImplVerifyPrompt == "" || got.SolutionVerifyPrompt == "" || got.SolutionVerifyCommand == "" {
		t.Fatalf("verification fields were not persisted: %+v", got)
	}
}

func TestWritePlanRejectsWeakTasksWithoutChangingQueue(t *testing.T) {
	s := testServer(t)
	bad := []byte(`{"goal":"Build feature","tasks":[{"title":"Do","description":"vague"}]}`)
	text, isError, err := s.onWritePlan(context.Background(), bad)
	if err != nil || !isError {
		t.Fatalf("weak plan: text=%s isError=%v err=%v", text, isError, err)
	}
	tasks, _ := queue.ListTasks(s.db)
	if len(tasks) != 0 {
		t.Fatalf("invalid plan wrote %d tasks", len(tasks))
	}
}

func TestPrimaryToolAdvertisesVerificationFields(t *testing.T) {
	s := testServer(t)
	if len(s.tools) == 0 || s.tools[0].Name != "task_queue_write_plan" {
		t.Fatalf("primary tool is not task_queue_write_plan")
	}
	if s.tools[0].OutputSchema["type"] != "object" || s.tools[0].Annotations["title"] == "" {
		t.Fatal("primary tool is missing structured output schema or annotations")
	}
	properties := s.tools[0].InputSchema["properties"].(map[string]any)
	tasks := properties["tasks"].(map[string]any)
	items := tasks["items"].(map[string]any)
	itemProps := items["properties"].(map[string]any)
	for _, key := range []string{"implementationCheck", "behaviorCheck", "verificationCommand"} {
		if _, ok := itemProps[key]; !ok {
			t.Errorf("task schema missing %s", key)
		}
	}
}

func TestInitializeNegotiatesClientVersion(t *testing.T) {
	var out bytes.Buffer
	s := &server{out: &out}
	id := json.RawMessage(`1`)
	s.handleInitialize(context.Background(), &rpcRequest{
		ID: &id, Params: json.RawMessage(`{"protocolVersion":"2025-06-18"}`),
	})
	var response struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			Instructions    string `json:"instructions"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out.Bytes(), &response); err != nil {
		t.Fatalf("decode initialize response: %v", err)
	}
	if response.Result.ProtocolVersion != "2025-06-18" {
		t.Fatalf("protocol=%q, want requested supported version", response.Result.ProtocolVersion)
	}
	if response.Result.Instructions == "" {
		t.Fatal("initialize response omitted server instructions")
	}
}
