package queue

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestFailedImportRequiresDecomposition(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	id, err := CreateTask(d, "original", "retain owner requirements", WithStatus(StatusFailed))
	if err != nil {
		t.Fatal(err)
	}
	saved, _, err := GetTask(d, id)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Status != StatusVerifying || saved.ActivityPhase != "decomposition_required" {
		t.Fatalf("FAILED import not scheduled for decomposition: %+v", saved)
	}
	for _, status := range []TaskStatus{StatusPending, StatusExecuting, StatusVerified, StatusFailed, StatusPaused} {
		if _, err := UpdateTask(d, id, TaskPatch{Status: &status}); err != nil {
			t.Fatal(err)
		}
		saved, _, err = GetTask(d, id)
		if err != nil {
			t.Fatal(err)
		}
		if saved.Status != StatusVerifying || saved.ActivityPhase != "decomposition_required" {
			t.Fatalf("status %s revived a failed parent: %+v", status, saved)
		}
	}
	if err := ReplaceAll(d, []NewTask{{Title: "imported", Description: "contract", Status: StatusFailed}}); err != nil {
		t.Fatal(err)
	}
	tasks, err := ListTasks(d)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Status != StatusVerifying || tasks[0].ActivityPhase != "decomposition_required" {
		t.Fatalf("replacement import retained a terminal failure: %+v", tasks)
	}
}

func TestLegacyResetPreservesDecompositionIdentity(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "queue.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	id, err := CreateTask(d, "original", "full contract")
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.db.Exec(`UPDATE tasks SET status='FAILED', attempts=3, started_at=42,
		activity_detail='exact ownership rejection', supervisor_feedback='repair guidance',
		last_activity_at=71 WHERE id=?`, id)
	if err != nil {
		t.Fatal(err)
	}
	before, _, err := GetTask(d, id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.db.Exec(`UPDATE tasks SET status='PENDING', attempts=0, started_at=NULL,
		activity_phase='', activity_detail='', supervisor_feedback='', last_activity_at=NULL,
		updated_at=0 WHERE id=?`, id)
	if err != nil {
		t.Fatal(err)
	}
	after, _, err := GetTask(d, id)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("legacy reset changed decomposition identity/evidence:\nbefore=%+v\nafter=%+v", before, after)
	}
}

func TestLegacyFailureMigrationPreservesEvidence(t *testing.T) {
	file := filepath.Join(t.TempDir(), "queue.db")
	d, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	id, err := CreateTask(d, "original", "full contract")
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.db.Exec(`DROP TRIGGER tasks_decomposition_insert;
   DROP TRIGGER tasks_decomposition_update;
   UPDATE tasks SET status='FAILED', output='worker output', validation_report='rejected check',
   error_log='supervisor test repair cannot rewrite application file', attempts=9, tokens_in=73,
   finished_at=12;`)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	reopened, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	saved, _, err := GetTask(reopened, id)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Status != StatusVerifying || saved.ActivityPhase != "decomposition_required" || saved.FinishedAt != nil {
		t.Fatalf("legacy failure was not migrated: %+v", saved)
	}
	if saved.Output != "worker output" || saved.ValidationReport != "rejected check" ||
		saved.ErrorLog != "supervisor test repair cannot rewrite application file" || saved.Attempts != 9 || saved.TokensIn != 73 {
		t.Fatalf("migration lost failure evidence: %+v", saved)
	}
	var events int
	if err := reopened.db.QueryRow("SELECT COUNT(*) FROM task_events WHERE kind='decomposition-required'").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("want one migration audit, got %d", events)
	}
}
