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

func TestUpdateDeleteReorderTools(t *testing.T) {
	s := testServer(t)

	create := func(title string) int64 {
		text, isError, err := s.onCreate(context.Background(), []byte(`{
			"title": "`+title+`",
			"description": "A self-contained description of the work to do.",
			"implementationCheck": "Inspect the resulting files.",
			"behaviorCheck": "Exercise the happy path."
		}`))
		if err != nil || isError {
			t.Fatalf("create %s: text=%s isError=%v err=%v", title, text, isError, err)
		}
		var out struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal([]byte(text), &out); err != nil {
			t.Fatalf("decode create response: %v", err)
		}
		return out.ID
	}

	idA := create("Task A")
	idB := create("Task B")
	_ = create("Task C")

	// task_queue_update changes only the fields supplied.
	updateParams, _ := json.Marshal(map[string]any{
		"id":     idA,
		"title":  "Task A renamed",
		"status": "PAUSED",
	})
	text, isError, err := s.onUpdate(context.Background(), updateParams)
	if err != nil || isError {
		t.Fatalf("update: text=%s isError=%v err=%v", text, isError, err)
	}
	task, ok, err := queue.GetTask(s.db, idA)
	if err != nil || !ok {
		t.Fatalf("GetTask after update: ok=%v err=%v", ok, err)
	}
	if task.Title != "Task A renamed" || task.Status != queue.StatusPaused {
		t.Fatalf("update did not apply: %+v", task)
	}

	// An empty update (unknown id) is reported as a tool error, not an RPC error.
	missingParams, _ := json.Marshal(map[string]any{"id": idA + 1000, "title": "Won't stick"})
	text, isError, err = s.onUpdate(context.Background(), missingParams)
	if err != nil || !isError {
		t.Fatalf("update missing id: text=%s isError=%v err=%v", text, isError, err)
	}

	// task_queue_delete removes the task and closes the seq gap.
	deleteParams, _ := json.Marshal(map[string]any{"id": idB})
	text, isError, err = s.onDelete(context.Background(), deleteParams)
	if err != nil || isError {
		t.Fatalf("delete: text=%s isError=%v err=%v", text, isError, err)
	}
	if _, ok, _ := queue.GetTask(s.db, idB); ok {
		t.Fatal("expected task B to be deleted")
	}

	// Deleting the same id again is a tool error, not an RPC error.
	text, isError, err = s.onDelete(context.Background(), deleteParams)
	if err != nil || !isError {
		t.Fatalf("re-delete: text=%s isError=%v err=%v", text, isError, err)
	}

	// task_queue_reorder renumbers the remaining tasks.
	remaining, err := queue.ListTasks(s.db)
	if err != nil || len(remaining) != 2 {
		t.Fatalf("expected 2 remaining tasks, got %d (err=%v)", len(remaining), err)
	}
	reversedIDs := []int64{remaining[1].ID, remaining[0].ID}
	reorderParams, _ := json.Marshal(map[string]any{"ids": reversedIDs})
	text, isError, err = s.onReorder(context.Background(), reorderParams)
	if err != nil || isError {
		t.Fatalf("reorder: text=%s isError=%v err=%v", text, isError, err)
	}
	reordered, err := queue.ListTasks(s.db)
	if err != nil {
		t.Fatalf("ListTasks after reorder: %v", err)
	}
	if reordered[0].ID != reversedIDs[0] || reordered[1].ID != reversedIDs[1] {
		t.Fatalf("reorder did not apply: %+v", reordered)
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
