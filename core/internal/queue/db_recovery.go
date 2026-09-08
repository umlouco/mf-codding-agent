package queue

// installDecompositionInvariant matches the TypeScript storage migration. SQL
// triggers also protect writes made by older workers and other database clients.
func (d *DB) installDecompositionInvariant() error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`
      DROP TRIGGER IF EXISTS tasks_decomposition_insert;
      DROP TRIGGER IF EXISTS tasks_decomposition_update;
      CREATE TRIGGER tasks_decomposition_insert
      AFTER INSERT ON tasks
      WHEN NEW.status = 'FAILED' OR
        (NEW.activity_phase GLOB 'decomposition_*' AND
          (NEW.status <> 'VERIFYING' OR NEW.finished_at IS NOT NULL))
      BEGIN
        UPDATE tasks SET status = 'VERIFYING', activity_phase = 'decomposition_required',
          finished_at = NULL WHERE id = NEW.id;
      END;
      CREATE TRIGGER tasks_decomposition_update
      AFTER UPDATE ON tasks
      WHEN NEW.status = 'FAILED' OR
        (NEW.activity_phase GLOB 'decomposition_*' AND
          (NEW.status <> 'VERIFYING' OR NEW.finished_at IS NOT NULL)) OR
        (OLD.activity_phase GLOB 'decomposition_*' AND
          (NEW.status <> 'VERIFYING' OR NEW.activity_phase NOT GLOB 'decomposition_*'))
      BEGIN
        UPDATE tasks SET status = 'VERIFYING', finished_at = NULL,
          activity_phase = CASE WHEN OLD.activity_phase GLOB 'decomposition_*'
            THEN OLD.activity_phase ELSE 'decomposition_required' END,
          output = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.output ELSE NEW.output END,
          validation_report = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.validation_report ELSE NEW.validation_report END,
          error_log = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.error_log ELSE NEW.error_log END,
          attempts = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.attempts ELSE NEW.attempts END,
          started_at = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.started_at ELSE NEW.started_at END,
          last_activity_at = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.last_activity_at ELSE NEW.last_activity_at END,
          activity_detail = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.activity_detail ELSE NEW.activity_detail END,
          supervisor_feedback = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.supervisor_feedback ELSE NEW.supervisor_feedback END,
          updated_at = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.updated_at ELSE NEW.updated_at END,
          tokens_in = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.tokens_in ELSE NEW.tokens_in END,
          tokens_out = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.tokens_out ELSE NEW.tokens_out END,
          tokens_cache_read = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.tokens_cache_read ELSE NEW.tokens_cache_read END,
          tokens_cache_write = CASE WHEN OLD.activity_phase GLOB 'decomposition_*' THEN OLD.tokens_cache_write ELSE NEW.tokens_cache_write END
        WHERE id = NEW.id;
      END;
      INSERT INTO task_events (task_id, actor, kind, message, at)
        SELECT id, 'system', 'decomposition-required',
          'Legacy FAILED task requires replacement by smaller tasks; evidence retained.',
          CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM tasks WHERE status = 'FAILED';
      UPDATE tasks SET status = 'VERIFYING', activity_phase = 'decomposition_required',
        finished_at = NULL WHERE status = 'FAILED';
    `); err != nil {
		return err
	}
	return tx.Commit()
}
