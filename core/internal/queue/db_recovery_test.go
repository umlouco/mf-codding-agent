package queue

import (
	"path/filepath"
	"testing"
)

// insertTaskRow inserts a minimal task with a given status and activity phase,
// returning its id. Raw SQL is used because the invariant under test lives in
// SQL triggers, below the package's typed helpers.
func insertTaskRow(t *testing.T, d *DB, status, phase string) int64 {
	t.Helper()
	res, err := d.db.Exec(`
		INSERT INTO tasks (title, description, seq, status, activity_phase, created_at, updated_at)
		VALUES ('task', '', 1, ?, ?, 0, 0)`, status, phase)
	if err != nil {
		t.Fatalf("insert task (status=%s phase=%s): %v", status, phase, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}
	return id
}

func taskState(t *testing.T, d *DB, id int64) (status, phase string) {
	t.Helper()
	if err := d.db.QueryRow(
		"SELECT status, activity_phase FROM tasks WHERE id = ?", id,
	).Scan(&status, &phase); err != nil {
		t.Fatalf("read task %d: %v", id, err)
	}
	return status, phase
}

// A task the queue cannot complete is BLOCKED for a human. That terminal write
// must survive the decomposition invariant: previously the trigger rewrote
// BLOCKED back to VERIFYING/decomposition_waiting, so blockTask could never
// commit and the supervisor re-decided the same row forever while every later
// task was head-of-line blocked behind it.
func TestBlockedSurvivesDecompositionInvariant(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatalf("open queue: %v", err)
	}
	defer d.Close()

	id := insertTaskRow(t, d, string(StatusVerifying), "decomposition_waiting")

	if _, err := d.db.Exec(
		`UPDATE tasks SET status = 'BLOCKED', activity_phase = 'blocked', finished_at = 123
		 WHERE id = ?`, id,
	); err != nil {
		t.Fatalf("block task: %v", err)
	}

	status, phase := taskState(t, d, id)
	if status != string(StatusBlocked) || phase != "blocked" {
		t.Fatalf("BLOCKED was not preserved: got status=%q phase=%q, want BLOCKED/blocked", status, phase)
	}
}

// The exemption must not weaken the invariant it exists for: a decomposition
// row still cannot be silently turned into runnable work.
func TestFailedAndDecompositionStillRewritten(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatalf("open queue: %v", err)
	}
	defer d.Close()

	failed := insertTaskRow(t, d, string(StatusFailed), "")
	if status, phase := taskState(t, d, failed); status != string(StatusVerifying) || phase != "decomposition_required" {
		t.Fatalf("FAILED insert not rewritten: got status=%q phase=%q", status, phase)
	}

	waiting := insertTaskRow(t, d, string(StatusVerifying), "decomposition_waiting")
	if _, err := d.db.Exec(
		"UPDATE tasks SET status = 'PENDING', activity_phase = '' WHERE id = ?", waiting,
	); err != nil {
		t.Fatalf("update decomposition row: %v", err)
	}
	if status, phase := taskState(t, d, waiting); status != string(StatusVerifying) || phase != "decomposition_waiting" {
		t.Fatalf("decomposition invariant weakened: got status=%q phase=%q, want VERIFYING/decomposition_waiting", status, phase)
	}
}
