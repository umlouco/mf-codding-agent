// Package queue provides shared SQLite access to the task queue database,
// matching the TypeScript TaskQueue schema in src/queue/db.ts so that the
// MCP server and the VS Code extension can read and write the same file.
package queue

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// TaskStatus is the closed set of states a task can be in.
type TaskStatus string

const (
	StatusPending   TaskStatus = "PENDING"
	StatusExecuting TaskStatus = "EXECUTING"
	StatusVerifying TaskStatus = "VERIFYING"
	StatusVerified  TaskStatus = "VERIFIED"
	StatusFailed    TaskStatus = "FAILED"
	StatusPaused    TaskStatus = "PAUSED"
)

// RunState tracks the queue's overall execution state.
type RunState string

const (
	RunIdle    RunState = "IDLE"
	RunRunning RunState = "RUNNING"
	RunPaused  RunState = "PAUSED"
	RunStopped RunState = "STOPPED"
)

// Task is a single row in the tasks table.
type Task struct {
	ID                    int64      `json:"id"`
	Title                 string     `json:"title"`
	Description           string     `json:"description"`
	ImplVerifyPrompt      string     `json:"implVerifyPrompt"`
	SolutionVerifyPrompt  string     `json:"solutionVerifyPrompt"`
	SolutionVerifyCommand string     `json:"solutionVerifyCommand"`
	Status                TaskStatus `json:"status"`
	Seq                   int        `json:"seq"`
	Output                string     `json:"output"`
	ValidationReport      string     `json:"validationReport"`
	ErrorLog              string     `json:"errorLog"`
	SupervisorFeedback    string     `json:"supervisorFeedback"`
	Attempts              int        `json:"attempts"`
	MaxAttempts           int        `json:"maxAttempts"`
	LastActivityAt        *int64     `json:"lastActivityAt"`
	ActivityPhase         string     `json:"activityPhase"`
	ActivityDetail        string     `json:"activityDetail"`
	TokensIn              int64      `json:"tokensIn"`
	TokensOut             int64      `json:"tokensOut"`
	TokensCacheRead       int64      `json:"tokensCacheRead"`
	TokensCacheWrite      int64      `json:"tokensCacheWrite"`
	CreatedAt             int64      `json:"createdAt"`
	UpdatedAt             int64      `json:"updatedAt"`
	StartedAt             *int64     `json:"startedAt"`
	FinishedAt            *int64     `json:"finishedAt"`
	// Kind is "task" (the default) or "phase" — a phase is a coarse slice of
	// the plan awaiting expansion into real tasks by the extension's queue
	// orchestrator, not something this server creates. It is mirrored here
	// purely so a client listing tasks sees what a row actually is instead of
	// a "task" with no verify prompts and no explanation why.
	Kind string `json:"kind"`
	// Region is set only on phase rows: JSON describing the workspace slice
	// (paths + file count) the expansion agent was bounded to.
	Region string `json:"region"`
}

// Usage holds token counts aggregated across tasks.
type Usage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// QueueStats is the summary returned by Stats().
type QueueStats struct {
	Total    int                `json:"total"`
	ByStatus map[TaskStatus]int `json:"byStatus"`
	RunState RunState           `json:"runState"`
	Usage    Usage              `json:"usage"`
}

// NewTask holds the fields accepted when creating a task.
type NewTask struct {
	Title                 string
	Description           string
	ImplVerifyPrompt      string
	SolutionVerifyPrompt  string
	SolutionVerifyCommand string
	Seq                   int
	MaxAttempts           int
	Status                TaskStatus
}

// DB wraps a single SQLite connection to a queue database.
type DB struct {
	db   *sql.DB
	path string
}

// Open opens (creating if needed) the queue database at the given path.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	d := &DB{db: db, path: path}
	if err := d.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return d, nil
}

// Close closes the database.
func (d *DB) Close() error {
	return d.db.Close()
}

// Path returns the filesystem path to the database file.
func (d *DB) Path() string { return d.path }

// ReplaceAll deletes every task row and inserts the given tasks in a single
// transaction, resetting the autoincrement sequence. The caller supplies
// title/description pairs; other columns use defaults.
func ReplaceAll(d *DB, tasks []NewTask) error {
	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("ReplaceAll begin: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec("DELETE FROM tasks"); err != nil {
		return fmt.Errorf("ReplaceAll delete: %w", err)
	}
	if _, err := tx.Exec("DELETE FROM sqlite_sequence WHERE name = 'tasks'"); err != nil {
		return fmt.Errorf("ReplaceAll reset: %w", err)
	}

	now := time.Now().UnixMilli()
	for i := range tasks {
		nt := &tasks[i]
		if nt.MaxAttempts <= 0 {
			nt.MaxAttempts = 3
		}
		if nt.Status == "" {
			nt.Status = StatusPending
		}
		if nt.Seq <= 0 {
			nt.Seq = i + 1
		}
		if _, err := tx.Exec(`
			INSERT INTO tasks (
				title, description, impl_verify_prompt, solution_verify_prompt,
				solution_verify_command, status, seq, max_attempts, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
			nt.Title, nt.Description,
			nt.ImplVerifyPrompt, nt.SolutionVerifyPrompt, nt.SolutionVerifyCommand,
			string(nt.Status), nt.Seq, nt.MaxAttempts, now, now,
		); err != nil {
			return fmt.Errorf("ReplaceAll insert: %w", err)
		}
	}

	return tx.Commit()
}

// migrate creates the schema if it does not already exist and applies any
// additive migrations. The DDL matches src/queue/db.ts exactly so the
// extension and the core share one schema.
func (d *DB) migrate() error {
	_, err := d.db.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA foreign_keys = ON;

		CREATE TABLE IF NOT EXISTS tasks (
			id                      INTEGER PRIMARY KEY AUTOINCREMENT,
			title                   TEXT    NOT NULL,
			description             TEXT    NOT NULL DEFAULT '',
			impl_verify_prompt      TEXT    NOT NULL DEFAULT '',
			solution_verify_prompt  TEXT    NOT NULL DEFAULT '',
			solution_verify_command TEXT    NOT NULL DEFAULT '',
			status                  TEXT    NOT NULL DEFAULT 'PENDING',
			seq                     INTEGER NOT NULL,
			output                  TEXT    NOT NULL DEFAULT '',
			validation_report       TEXT    NOT NULL DEFAULT '',
			error_log               TEXT    NOT NULL DEFAULT '',
			supervisor_feedback     TEXT    NOT NULL DEFAULT '',
			attempts                INTEGER NOT NULL DEFAULT 0,
			max_attempts            INTEGER NOT NULL DEFAULT 3,
			created_at              INTEGER NOT NULL,
			updated_at              INTEGER NOT NULL,
			started_at              INTEGER,
			finished_at             INTEGER,
			CHECK (status IN ('PENDING','EXECUTING','VERIFYING','VERIFIED','FAILED','PAUSED'))
		);

		CREATE INDEX IF NOT EXISTS idx_tasks_status_seq ON tasks(status, seq);
		CREATE INDEX IF NOT EXISTS idx_tasks_seq        ON tasks(seq);

		CREATE TABLE IF NOT EXISTS task_events (
			id      INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
			actor   TEXT NOT NULL,
			kind    TEXT NOT NULL,
			message TEXT NOT NULL DEFAULT '',
			at      INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

		CREATE TABLE IF NOT EXISTS queue_meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`)
	if err != nil {
		return fmt.Errorf("queue migrate: %w", err)
	}

	// Additive column migrations matching the TS addColumn calls.
	d.addColumn("last_activity_at", "INTEGER")
	d.addColumn("activity_phase", "TEXT NOT NULL DEFAULT ''")
	d.addColumn("activity_detail", "TEXT NOT NULL DEFAULT ''")
	for _, c := range []string{"tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_write"} {
		d.addColumn(c, "INTEGER NOT NULL DEFAULT 0")
	}
	d.addColumn("kind", "TEXT NOT NULL DEFAULT 'task'")
	d.addColumn("region", "TEXT NOT NULL DEFAULT ''")
	d.addColumn("validation_report", "TEXT NOT NULL DEFAULT ''")

	return nil
}

// addColumn adds a column to tasks if it does not already exist.
func (d *DB) addColumn(name, decl string) {
	rows, err := d.db.Query("PRAGMA table_info(tasks)")
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var cname, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &cname, &ctype, &notnull, &dflt, &pk); err != nil {
			continue
		}
		if cname == name {
			return
		}
	}
	// Column does not exist — add it.
	_, _ = d.db.Exec("ALTER TABLE tasks ADD COLUMN " + name + " " + decl)
}

// CreateTask inserts a new task into the queue and returns its rowid.
// title and description are required; all other fields are optional and
// default to the values in NewTask.
func CreateTask(d *DB, title, description string, opts ...func(*NewTask)) (int64, error) {
	nt := NewTask{
		Title:       title,
		Description: description,
		MaxAttempts: 3,
		Status:      StatusPending,
	}
	for _, o := range opts {
		o(&nt)
	}
	if nt.Seq <= 0 {
		nt.Seq = d.maxSeq() + 1
	}

	now := time.Now().UnixMilli()
	res, err := d.db.Exec(`
		INSERT INTO tasks (
			title, description, impl_verify_prompt, solution_verify_prompt,
			solution_verify_command, status, seq, max_attempts, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		nt.Title,
		nt.Description,
		nt.ImplVerifyPrompt,
		nt.SolutionVerifyPrompt,
		nt.SolutionVerifyCommand,
		string(nt.Status),
		nt.Seq,
		nt.MaxAttempts,
		now,
		now,
	)
	if err != nil {
		return 0, fmt.Errorf("CreateTask: %w", err)
	}
	return res.LastInsertId()
}

// WithSeq sets the task's execution order (1-based).
func WithSeq(seq int) func(*NewTask) {
	return func(nt *NewTask) { nt.Seq = seq }
}

// WithMaxAttempts sets how many times the task may be retried.
func WithMaxAttempts(n int) func(*NewTask) {
	return func(nt *NewTask) { nt.MaxAttempts = n }
}

// WithStatus sets the initial status (defaults to PENDING).
func WithStatus(s TaskStatus) func(*NewTask) {
	return func(nt *NewTask) { nt.Status = s }
}

// WithImplVerifyPrompt sets the implementation verification prompt.
func WithImplVerifyPrompt(p string) func(*NewTask) {
	return func(nt *NewTask) { nt.ImplVerifyPrompt = p }
}

// WithSolutionVerifyPrompt sets the solution verification prompt.
func WithSolutionVerifyPrompt(p string) func(*NewTask) {
	return func(nt *NewTask) { nt.SolutionVerifyPrompt = p }
}

// WithSolutionVerifyCommand sets the shell command for functional verification.
func WithSolutionVerifyCommand(cmd string) func(*NewTask) {
	return func(nt *NewTask) { nt.SolutionVerifyCommand = cmd }
}

// maxSeq returns the highest seq value currently in the tasks table.
func (d *DB) maxSeq() int {
	var m int
	err := d.db.QueryRow("SELECT COALESCE(MAX(seq), 0) FROM tasks").Scan(&m)
	if err != nil {
		return 0
	}
	return m
}

// ListTasks returns every task ordered by seq then id.
func ListTasks(d *DB) ([]Task, error) {
	rows, err := d.db.Query(taskColumns + " FROM tasks ORDER BY seq ASC, id ASC")
	if err != nil {
		return nil, fmt.Errorf("ListTasks: %w", err)
	}
	defer rows.Close()
	return scanTasks(rows)
}

// Stats returns aggregate counts grouped by status plus token usage.
func Stats(d *DB) (QueueStats, error) {
	s := QueueStats{
		ByStatus: map[TaskStatus]int{
			StatusPending:   0,
			StatusExecuting: 0,
			StatusVerifying: 0,
			StatusVerified:  0,
			StatusFailed:    0,
			StatusPaused:    0,
		},
	}

	rows, err := d.db.Query("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
	if err != nil {
		return s, fmt.Errorf("Stats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			continue
		}
		s.ByStatus[TaskStatus(st)] = n
		s.Total += n
	}
	if err := rows.Err(); err != nil {
		return s, fmt.Errorf("Stats: %w", err)
	}

	// Usage sums across all tasks.
	var u Usage
	err = d.db.QueryRow(`
		SELECT COALESCE(SUM(tokens_in), 0),
		       COALESCE(SUM(tokens_out), 0),
		       COALESCE(SUM(tokens_cache_read), 0),
		       COALESCE(SUM(tokens_cache_write), 0)
		  FROM tasks
	`).Scan(&u.Input, &u.Output, &u.CacheRead, &u.CacheWrite)
	if err != nil {
		return s, fmt.Errorf("Stats usage: %w", err)
	}
	s.Usage = u

	// Run state from queue_meta.
	var rs string
	err = d.db.QueryRow("SELECT value FROM queue_meta WHERE key = 'runState'").Scan(&rs)
	if err == nil {
		s.RunState = RunState(rs)
	} else {
		s.RunState = RunIdle
	}

	return s, nil
}

// taskColumns is the SELECT list matching the TS COLUMNS constant, used by
// every query that reads task rows.
const taskColumns = `
SELECT id, title, description,
       impl_verify_prompt, solution_verify_prompt, solution_verify_command,
       status, seq, output,
       validation_report,
       error_log, supervisor_feedback,
       attempts, max_attempts,
       last_activity_at, activity_phase, activity_detail,
       tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
       created_at, updated_at, started_at, finished_at,
       kind, region
`

// rowScanner is implemented by both *sql.Row and *sql.Rows, letting scanTask
// back a single-row lookup (GetTask) and a multi-row cursor (scanTasks) with
// one column list.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanTask reads one task row matching the taskColumns column list.
func scanTask(row rowScanner) (Task, error) {
	var t Task
	err := row.Scan(
		&t.ID, &t.Title, &t.Description,
		&t.ImplVerifyPrompt, &t.SolutionVerifyPrompt, &t.SolutionVerifyCommand,
		&t.Status, &t.Seq, &t.Output,
		&t.ValidationReport,
		&t.ErrorLog, &t.SupervisorFeedback,
		&t.Attempts, &t.MaxAttempts,
		&t.LastActivityAt, &t.ActivityPhase, &t.ActivityDetail,
		&t.TokensIn, &t.TokensOut, &t.TokensCacheRead, &t.TokensCacheWrite,
		&t.CreatedAt, &t.UpdatedAt, &t.StartedAt, &t.FinishedAt,
		&t.Kind, &t.Region,
	)
	return t, err
}

// scanTasks reads a *sql.Rows cursor into a slice of Task.
func scanTasks(rows *sql.Rows) ([]Task, error) {
	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return out, fmt.Errorf("scanTasks: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTask returns a single task by id, or ok=false if no task has that id.
func GetTask(d *DB, id int64) (Task, bool, error) {
	t, err := scanTask(d.db.QueryRow(taskColumns+" FROM tasks WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, fmt.Errorf("GetTask: %w", err)
	}
	return t, true, nil
}

// TaskPatch holds an optional per-field update. A nil field is left
// unchanged, mirroring TaskQueue.update's Partial<Task> patch in
// src/queue/db.ts.
type TaskPatch struct {
	Title                 *string
	Description           *string
	ImplVerifyPrompt      *string
	SolutionVerifyPrompt  *string
	SolutionVerifyCommand *string
	Status                *TaskStatus
	Seq                   *int
	MaxAttempts           *int
}

// validStatuses is the same closed set enforced by the tasks.status CHECK
// constraint.
var validStatuses = map[TaskStatus]bool{
	StatusPending: true, StatusExecuting: true, StatusVerifying: true,
	StatusVerified: true, StatusFailed: true, StatusPaused: true,
}

// UpdateTask applies a partial patch to an existing task, matching
// TaskQueue.update. It reports whether a row was changed — false when the id
// does not exist or the patch set no fields.
func UpdateTask(d *DB, id int64, patch TaskPatch) (bool, error) {
	var sets []string
	var args []any
	set := func(col string, v any) {
		sets = append(sets, col+" = ?")
		args = append(args, v)
	}

	if patch.Title != nil {
		set("title", *patch.Title)
	}
	if patch.Description != nil {
		set("description", *patch.Description)
	}
	if patch.ImplVerifyPrompt != nil {
		set("impl_verify_prompt", *patch.ImplVerifyPrompt)
	}
	if patch.SolutionVerifyPrompt != nil {
		set("solution_verify_prompt", *patch.SolutionVerifyPrompt)
	}
	if patch.SolutionVerifyCommand != nil {
		set("solution_verify_command", *patch.SolutionVerifyCommand)
	}
	if patch.Status != nil {
		if !validStatuses[*patch.Status] {
			return false, fmt.Errorf("invalid status %q", *patch.Status)
		}
		set("status", string(*patch.Status))
	}
	if patch.Seq != nil {
		set("seq", *patch.Seq)
	}
	if patch.MaxAttempts != nil {
		set("max_attempts", *patch.MaxAttempts)
	}
	if len(sets) == 0 {
		return false, nil
	}

	sets = append(sets, "updated_at = ?")
	args = append(args, time.Now().UnixMilli(), id)
	res, err := d.db.Exec(
		fmt.Sprintf("UPDATE tasks SET %s WHERE id = ?", strings.Join(sets, ", ")),
		args...,
	)
	if err != nil {
		return false, fmt.Errorf("UpdateTask: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("UpdateTask: %w", err)
	}
	return n > 0, nil
}

// DeleteTask removes a task and closes the seq gap it leaves, matching
// TaskQueue.remove. It reports whether a task was actually deleted.
func DeleteTask(d *DB, id int64) (bool, error) {
	tx, err := d.db.Begin()
	if err != nil {
		return false, fmt.Errorf("DeleteTask begin: %w", err)
	}
	defer tx.Rollback()

	var seq int
	err = tx.QueryRow("SELECT seq FROM tasks WHERE id = ?", id).Scan(&seq)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("DeleteTask lookup: %w", err)
	}
	if _, err := tx.Exec("DELETE FROM tasks WHERE id = ?", id); err != nil {
		return false, fmt.Errorf("DeleteTask delete: %w", err)
	}
	if _, err := tx.Exec(
		"UPDATE tasks SET seq = seq - 1, updated_at = ? WHERE seq > ?",
		time.Now().UnixMilli(), seq,
	); err != nil {
		return false, fmt.Errorf("DeleteTask renumber: %w", err)
	}
	return true, tx.Commit()
}

// ReorderTasks renumbers seq to 1..n following idsInOrder, matching
// TaskQueue.reorder. Callers should pass every task id in the queue; ids that
// don't exist are silently skipped, and any task id left out keeps its
// current seq, which can collide with the new numbering.
func ReorderTasks(d *DB, idsInOrder []int64) error {
	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("ReorderTasks begin: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare("UPDATE tasks SET seq = ?, updated_at = ? WHERE id = ?")
	if err != nil {
		return fmt.Errorf("ReorderTasks prepare: %w", err)
	}
	defer stmt.Close()

	now := time.Now().UnixMilli()
	for i, id := range idsInOrder {
		if _, err := stmt.Exec(i+1, now, id); err != nil {
			return fmt.Errorf("ReorderTasks: %w", err)
		}
	}
	return tx.Commit()
}
