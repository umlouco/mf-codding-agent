package queue

import (
	"fmt"
	"time"
)

// WritePlan atomically writes a complete externally-authored plan. When
// replace is false the tasks are appended after the current maximum sequence.
// The goal is stored beside the queue so the extension and other MCP clients
// can understand why the list exists.
func WritePlan(d *DB, tasks []NewTask, goal string, replace bool) error {
	if len(tasks) == 0 {
		return fmt.Errorf("plan must contain at least one task")
	}
	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("WritePlan begin: %w", err)
	}
	defer tx.Rollback()

	start := 0
	if replace {
		if _, err := tx.Exec("DELETE FROM tasks"); err != nil {
			return fmt.Errorf("WritePlan delete: %w", err)
		}
		if _, err := tx.Exec("DELETE FROM sqlite_sequence WHERE name = 'tasks'"); err != nil {
			return fmt.Errorf("WritePlan reset sequence: %w", err)
		}
	} else if err := tx.QueryRow("SELECT COALESCE(MAX(seq), 0) FROM tasks").Scan(&start); err != nil {
		return fmt.Errorf("WritePlan sequence: %w", err)
	}

	now := time.Now().UnixMilli()
	for i, task := range tasks {
		maxAttempts := task.MaxAttempts
		if maxAttempts <= 0 {
			maxAttempts = 3
		}
		_, err := tx.Exec(`
			INSERT INTO tasks (
				title, description, impl_verify_prompt, solution_verify_prompt,
				solution_verify_command, status, seq, max_attempts, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
		`, task.Title, task.Description, task.ImplVerifyPrompt,
			task.SolutionVerifyPrompt, task.SolutionVerifyCommand,
			start+i+1, maxAttempts, now, now)
		if err != nil {
			return fmt.Errorf("WritePlan task %d: %w", i+1, err)
		}
	}

	if _, err := tx.Exec(`
		INSERT INTO queue_meta (key, value) VALUES ('goal', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value
	`, goal); err != nil {
		return fmt.Errorf("WritePlan goal: %w", err)
	}
	if replace {
		if _, err := tx.Exec(`
			INSERT INTO queue_meta (key, value) VALUES ('runState', 'IDLE')
			ON CONFLICT(key) DO UPDATE SET value = 'IDLE'
		`); err != nil {
			return fmt.Errorf("WritePlan run state: %w", err)
		}
	}
	return tx.Commit()
}
