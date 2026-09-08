package queue

import (
	"database/sql"
	"fmt"
)

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

	return d.installDecompositionInvariant()
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
