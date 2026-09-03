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

func TestUpdateTask(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	id, err := CreateTask(db, "Original title", "Original description", WithSeq(1))
	if err != nil {
		t.Fatalf("CreateTask: %v", err)
	}

	// Updating no fields changes nothing and reports false.
	if changed, err := UpdateTask(db, id, TaskPatch{}); err != nil || changed {
		t.Fatalf("empty patch: changed=%v err=%v", changed, err)
	}

	newTitle := "Updated title"
	status := StatusPaused
	maxAttempts := 7
	changed, err := UpdateTask(db, id, TaskPatch{
		Title:       &newTitle,
		Status:      &status,
		MaxAttempts: &maxAttempts,
	})
	if err != nil {
		t.Fatalf("UpdateTask: %v", err)
	}
	if !changed {
		t.Fatal("expected UpdateTask to report a change")
	}

	got, ok, err := GetTask(db, id)
	if err != nil || !ok {
		t.Fatalf("GetTask: ok=%v err=%v", ok, err)
	}
	if got.Title != newTitle {
		t.Fatalf("expected title %q, got %q", newTitle, got.Title)
	}
	if got.Description != "Original description" {
		t.Fatalf("untouched field changed: description=%q", got.Description)
	}
	if got.Status != StatusPaused {
		t.Fatalf("expected status PAUSED, got %s", got.Status)
	}
	if got.MaxAttempts != 7 {
		t.Fatalf("expected maxAttempts 7, got %d", got.MaxAttempts)
	}

	// Updating a non-existent task reports false, not an error.
	if changed, err := UpdateTask(db, id+999, TaskPatch{Title: &newTitle}); err != nil || changed {
		t.Fatalf("missing id: changed=%v err=%v", changed, err)
	}

	// An invalid status is rejected.
	bad := TaskStatus("NOT_A_STATUS")
	if _, err := UpdateTask(db, id, TaskPatch{Status: &bad}); err == nil {
		t.Fatal("expected an error for an invalid status")
	}
}

func TestDeleteTaskClosesSeqGap(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	id1, _ := CreateTask(db, "First", "d", WithSeq(1))
	id2, _ := CreateTask(db, "Second", "d", WithSeq(2))
	id3, _ := CreateTask(db, "Third", "d", WithSeq(3))

	deleted, err := DeleteTask(db, id2)
	if err != nil || !deleted {
		t.Fatalf("DeleteTask: deleted=%v err=%v", deleted, err)
	}

	tasks, err := ListTasks(db)
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks after delete, got %d", len(tasks))
	}
	byID := map[int64]Task{}
	for _, task := range tasks {
		byID[task.ID] = task
	}
	if byID[id1].Seq != 1 {
		t.Fatalf("expected first task to keep seq 1, got %d", byID[id1].Seq)
	}
	if byID[id3].Seq != 2 {
		t.Fatalf("expected third task to shift to seq 2, got %d", byID[id3].Seq)
	}

	// Deleting an id that no longer exists reports false, not an error.
	if deleted, err := DeleteTask(db, id2); err != nil || deleted {
		t.Fatalf("re-delete: deleted=%v err=%v", deleted, err)
	}
}

func TestReorderTasks(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	idA, _ := CreateTask(db, "A", "d", WithSeq(1))
	idB, _ := CreateTask(db, "B", "d", WithSeq(2))
	idC, _ := CreateTask(db, "C", "d", WithSeq(3))

	if err := ReorderTasks(db, []int64{idC, idA, idB}); err != nil {
		t.Fatalf("ReorderTasks: %v", err)
	}

	tasks, err := ListTasks(db)
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if len(tasks) != 3 || tasks[0].ID != idC || tasks[1].ID != idA || tasks[2].ID != idB {
		t.Fatalf("unexpected order: %+v", tasks)
	}
	if tasks[0].Seq != 1 || tasks[1].Seq != 2 || tasks[2].Seq != 3 {
		t.Fatalf("seq not renumbered: %+v", tasks)
	}
}
