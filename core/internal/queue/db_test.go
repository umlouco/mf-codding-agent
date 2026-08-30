package queue

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCreateListStatsClose(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "queue.db")

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// ListTasks should return empty initially.
	tasks, err := ListTasks(db)
	if err != nil {
		t.Fatalf("ListTasks (empty): %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("expected 0 tasks, got %d", len(tasks))
	}

	// CreateTask inserts a row and returns its id.
	id, err := CreateTask(db, "Test task", "Do something", WithSeq(1))
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}
	if id != 1 {
		t.Fatalf("expected id 1, got %d", id)
	}

	// ListTasks should now return the inserted task.
	tasks, err = ListTasks(db)
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("expected 1 task, got %d", len(tasks))
	}
	t1 := tasks[0]
	if t1.Title != "Test task" {
		t.Fatalf("expected title %q, got %q", "Test task", t1.Title)
	}
	if t1.Description != "Do something" {
		t.Fatalf("expected description %q, got %q", "Do something", t1.Description)
	}
	if t1.Status != StatusPending {
		t.Fatalf("expected status PENDING, got %s", t1.Status)
	}
	if t1.Seq != 1 {
		t.Fatalf("expected seq 1, got %d", t1.Seq)
	}
	if t1.MaxAttempts != 3 {
		t.Fatalf("expected maxAttempts 3, got %d", t1.MaxAttempts)
	}
	if t1.Kind != "task" {
		t.Fatalf("expected kind %q (this server never creates phases), got %q", "task", t1.Kind)
	}

	// Stats should reflect the single task.
	stats, err := Stats(db)
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats.Total != 1 {
		t.Fatalf("expected total 1, got %d", stats.Total)
	}
	if stats.ByStatus[StatusPending] != 1 {
		t.Fatalf("expected 1 PENDING, got %d", stats.ByStatus[StatusPending])
	}

	// Insert a second task with options.
	id2, err := CreateTask(db, "Second", "Something else",
		WithSeq(2), WithMaxAttempts(5), WithStatus(StatusExecuting))
	if err != nil {
		t.Fatalf("CreateTask 2: %v", err)
	}
	if id2 != 2 {
		t.Fatalf("expected id 2, got %d", id2)
	}

	tasks, err = ListTasks(db)
	if err != nil {
		t.Fatalf("ListTasks after second: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}

	stats, err = Stats(db)
	if err != nil {
		t.Fatalf("Stats 2: %v", err)
	}
	if stats.Total != 2 {
		t.Fatalf("expected total 2, got %d", stats.Total)
	}

	// Close should succeed.
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Verify the file exists on disk.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("db file missing after close: %v", err)
	}
}
