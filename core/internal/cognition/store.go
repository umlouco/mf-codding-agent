package cognition

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db       *sql.DB
	ownerPID int
	running  func(int) (bool, error)
}

func Open(path string) (*Store, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	uri := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(filepath.ToSlash(abs))
	db, err := sql.Open("sqlite", "file:"+uri+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(FULL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db, ownerPID: os.Getpid(), running: ownerRunning}
	_, err = db.Exec(`
CREATE TABLE IF NOT EXISTS cognition_clock (id INTEGER PRIMARY KEY CHECK(id = 1), epoch INTEGER NOT NULL);
INSERT OR IGNORE INTO cognition_clock(id, epoch) VALUES(1, 0);
CREATE TABLE IF NOT EXISTS cognition_events (
 work_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
 prev_hash TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY(work_id, seq));
CREATE TABLE IF NOT EXISTS cognition_state (
 work_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, head_hash TEXT NOT NULL, state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cognition_receipts (
 work_id TEXT NOT NULL, op_id TEXT NOT NULL, digest TEXT NOT NULL, seq INTEGER NOT NULL,
 PRIMARY KEY(work_id, op_id));
CREATE TABLE IF NOT EXISTS cognition_active (
 op_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, observer TEXT NOT NULL, run_id TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS cognition_operation_events
 ON cognition_events(work_id, kind, json_extract(payload, '$.ticket.id'))
 WHERE kind IN ('start', 'finish');`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func validateScope(scope Scope) error {
	if scope.WorkID == "" || scope.Observer == "" || scope.RunID == "" ||
		len(scope.WorkID) > 256 || len(scope.Observer) > 64 || len(scope.RunID) > 256 {
		return fmt.Errorf("cognition needs bounded work, observer and run identities")
	}
	return nil
}

type transaction struct {
	ctx   context.Context
	conn  *sql.Conn
	scope Scope
	state State
	head  string
	epoch int64
}

// BEGIN IMMEDIATE serializes reduction across processes, not just goroutines.
// Event, receipt, workspace clock and materialized state commit together.
func (s *Store) transact(scope Scope, fn func(*transaction) error) (Snapshot, error) {
	if err := validateScope(scope); err != nil {
		return Snapshot{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return Snapshot{}, err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	t := &transaction{ctx: ctx, conn: conn, scope: scope, state: NewState()}
	if err = t.load(); err != nil {
		// The materialized working set is replaceable. Recover it only from a
		// complete verified journal; damaged history is never guessed or erased.
		if replayErr := t.restore(); replayErr != nil {
			return Snapshot{}, fmt.Errorf("%v; journal recovery failed: %w", err, replayErr)
		}
	}
	if err = conn.QueryRowContext(ctx, "SELECT epoch FROM cognition_clock WHERE id=1").Scan(&t.epoch); err != nil {
		return Snapshot{}, err
	}
	if err = fn(t); err != nil {
		return Snapshot{}, err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return Snapshot{}, err
	}
	return Project(t.state, scope), nil
}

func (t *transaction) load() error {
	var stateJSON string
	var seq int64
	err := t.conn.QueryRowContext(t.ctx, "SELECT seq,head_hash,state_json FROM cognition_state WHERE work_id=?", t.scope.WorkID).Scan(&seq, &t.head, &stateJSON)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if errors.Is(err, sql.ErrNoRows) {
		var count int
		if err = t.conn.QueryRowContext(t.ctx, "SELECT COUNT(*) FROM cognition_events WHERE work_id=?", t.scope.WorkID).Scan(&count); err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("cognition snapshot missing")
		}
		return nil
	}
	if err == nil {
		if err = json.Unmarshal([]byte(stateJSON), &t.state); err != nil {
			return fmt.Errorf("invalid cognition snapshot: %w", err)
		}
		if t.state.Seq != seq || t.state.Version != PolicyVersion {
			return fmt.Errorf("cognition snapshot version/sequence mismatch")
		}
		var payload, previous, hash string
		// A valid older snapshot is still obsolete. Compare against the actual
		// journal head so restoring an old cache cannot hide later observations.
		if err = t.conn.QueryRowContext(t.ctx, "SELECT payload,prev_hash,hash FROM cognition_events WHERE work_id=? ORDER BY seq DESC LIMIT 1", t.scope.WorkID).Scan(&payload, &previous, &hash); err != nil {
			return err
		}
		var event Event
		if err = json.Unmarshal([]byte(payload), &event); err != nil {
			return err
		}
		if hash != t.head || hash != digest(previous+"\n"+payload) || event.StateHash != digest(stateJSON) {
			return fmt.Errorf("cognition journal/snapshot integrity mismatch")
		}
	}
	return nil
}

func (t *transaction) restore() error {
	rows, err := t.conn.QueryContext(t.ctx, "SELECT seq,kind,prev_hash,hash,payload FROM cognition_events WHERE work_id=? ORDER BY seq", t.scope.WorkID)
	if err != nil {
		return err
	}
	defer rows.Close()
	state := NewState()
	head := ""
	pending := map[string]Ticket{}
	orphaned := map[string]bool{}
	type receipt struct {
		id, hash string
		seq      int64
	}
	var receipts []receipt
	for rows.Next() {
		var seq int64
		var kind, previous, hash, payload string
		if err = rows.Scan(&seq, &kind, &previous, &hash, &payload); err != nil {
			return err
		}
		var e Event
		if err = json.Unmarshal([]byte(payload), &e); err != nil {
			return err
		}
		if e.Scope.WorkID != t.scope.WorkID || e.Seq != seq || e.Kind != kind || previous != head || hash != digest(previous+"\n"+payload) {
			return fmt.Errorf("invalid cognition chain at %d", seq)
		}
		if e.Kind == "start" && e.Ticket != nil {
			pending[e.Ticket.ID] = *e.Ticket
		}
		if e.Kind == "orphan" && e.Ticket != nil {
			orphaned[e.Ticket.ID] = true
		}
		if e.Kind == "finish" && e.Ticket != nil {
			if original, exists := pending[e.Ticket.ID]; !exists || original != *e.Ticket {
				return fmt.Errorf("unpaired cognition result at %d", seq)
			}
			delete(pending, e.Ticket.ID)
			receipts = append(receipts, receipt{e.Ticket.ID, e.Digest, seq})
		}
		if err = Apply(&state, e); err != nil {
			return err
		}
		data, _ := json.Marshal(state)
		if e.StateHash != digest(string(data)) {
			return fmt.Errorf("cognition replay mismatch at %d", seq)
		}
		head = hash
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	if state.Seq == 0 {
		return fmt.Errorf("no verified history to restore")
	}
	data, _ := json.Marshal(state)
	if _, err = t.conn.ExecContext(t.ctx, `INSERT INTO cognition_state(work_id,seq,head_hash,state_json) VALUES(?,?,?,?)
ON CONFLICT(work_id) DO UPDATE SET seq=excluded.seq,head_hash=excluded.head_hash,state_json=excluded.state_json`, t.scope.WorkID, state.Seq, head, string(data)); err != nil {
		return err
	}
	if _, err = t.conn.ExecContext(t.ctx, "DELETE FROM cognition_active WHERE work_id=?", t.scope.WorkID); err != nil {
		return err
	}
	for _, op := range pending {
		if op.Mutating && !orphaned[op.ID] {
			if _, err = t.conn.ExecContext(t.ctx, "INSERT INTO cognition_active(op_id,work_id,observer,run_id) VALUES(?,?,?,?)", op.ID, op.WorkID, op.Observer, op.RunID); err != nil {
				return err
			}
		}
	}
	if _, err = t.conn.ExecContext(t.ctx, "DELETE FROM cognition_receipts WHERE work_id=?", t.scope.WorkID); err != nil {
		return err
	}
	for _, r := range receipts {
		if _, err = t.conn.ExecContext(t.ctx, "INSERT INTO cognition_receipts(work_id,op_id,digest,seq) VALUES(?,?,?,?)", t.scope.WorkID, r.id, r.hash, r.seq); err != nil {
			return err
		}
	}
	t.state, t.head = state, head
	return nil
}

func (t *transaction) advance() error {
	t.epoch++
	_, err := t.conn.ExecContext(t.ctx, "UPDATE cognition_clock SET epoch=? WHERE id=1", t.epoch)
	return err
}

func (t *transaction) append(e Event) error {
	e.Version, e.Seq, e.Scope, e.Epoch = PolicyVersion, t.state.Seq+1, t.scope, t.epoch
	if err := Apply(&t.state, e); err != nil {
		return err
	}
	stateJSON, err := json.Marshal(t.state)
	if err != nil {
		return err
	}
	e.StateHash = digest(string(stateJSON))
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	hash := digest(t.head + "\n" + string(payload))
	if _, err = t.conn.ExecContext(t.ctx,
		"INSERT INTO cognition_events(work_id,seq,kind,prev_hash,hash,payload) VALUES(?,?,?,?,?,?)",
		t.scope.WorkID, e.Seq, e.Kind, t.head, hash, string(payload)); err != nil {
		return err
	}
	if _, err = t.conn.ExecContext(t.ctx,
		`INSERT INTO cognition_state(work_id,seq,head_hash,state_json) VALUES(?,?,?,?)
ON CONFLICT(work_id) DO UPDATE SET seq=excluded.seq,head_hash=excluded.head_hash,state_json=excluded.state_json`,
		t.scope.WorkID, e.Seq, hash, string(stateJSON)); err != nil {
		return err
	}
	t.head = hash
	return nil
}

func (t *transaction) sync() error {
	if t.state.Epoch != t.epoch {
		return t.append(Event{Kind: "sync"})
	}
	return nil
}

func (s *Store) StartRun(scope Scope) (Snapshot, error) {
	return s.transact(scope, func(t *transaction) error {
		if err := s.sweepOwners(t); err != nil {
			return err
		}
		if t.state.Runs[scope.Observer] == scope.RunID {
			return t.sync()
		}
		// A replacement cannot prove an old mutation stopped. Preserve its
		// global overlap marker until a result arrives, as well as its local
		// interrupted history. Uncertainty never withdraws access to tools.
		// A process gap withdraws freshness for this observer's old run. It is
		// not a workspace mutation: starting a supervisor must not invalidate
		// an executor's live observations. Evidence carries its source run.
		return t.append(Event{Kind: "run"})
	})
}

func (s *Store) Begin(scope Scope, callID, tool string, input json.RawMessage, mutating bool) (Ticket, error) {
	var ticket Ticket
	_, err := s.transact(scope, func(t *transaction) error {
		if t.state.Runs[scope.Observer] != scope.RunID {
			return fmt.Errorf("cognition run is not current for observer %q", scope.Observer)
		}
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return err
		}
		if mutating {
			if err := t.advance(); err != nil {
				return err
			}
		}
		canonical := canonicalInput(input)
		var active int
		if err := t.conn.QueryRowContext(t.ctx, "SELECT COUNT(*) FROM cognition_active").Scan(&active); err != nil {
			return err
		}
		ticket = Ticket{Scope: scope, ID: hex.EncodeToString(nonce[:]), OwnerPID: s.ownerPID, CallID: callID,
			Tool: tool, Action: digest(tool + "\n" + canonical), Summary: describe(tool, canonical),
			Mutating: mutating, ConcurrentMutation: active > 0, Epoch: t.epoch, StartSeq: t.state.Seq + 1}
		if mutating {
			if _, err := t.conn.ExecContext(t.ctx, "INSERT INTO cognition_active(op_id,work_id,observer,run_id) VALUES(?,?,?,?)", ticket.ID, scope.WorkID, scope.Observer, scope.RunID); err != nil {
				return err
			}
		}
		return t.append(Event{Kind: "start", Ticket: &ticket})
	})
	return ticket, err
}

func (s *Store) Finish(ticket Ticket, outcome Outcome) (Snapshot, error) {
	failed := outcome.IsError || outcome.ExitCode != nil && *outcome.ExitCode != 0
	unknown := ticket.Tool == "run_shell" && !failed && outcome.ExitCode == nil
	meta, _ := json.Marshal(struct {
		Error bool
		Exit  *int
	}{failed, outcome.ExitCode})
	hash := digest(string(meta) + "\n" + outcome.Output) // full output, before excerpting
	return s.transact(ticket.Scope, func(t *transaction) error {
		var original string
		if err := t.conn.QueryRowContext(t.ctx, "SELECT payload FROM cognition_events WHERE work_id=? AND seq=? AND kind='start'", ticket.WorkID, ticket.StartSeq).Scan(&original); err != nil {
			return fmt.Errorf("missing invocation start: %w", err)
		}
		var started Event
		if err := json.Unmarshal([]byte(original), &started); err != nil {
			return err
		}
		if started.Ticket == nil || *started.Ticket != ticket {
			return fmt.Errorf("invocation ticket does not match its recorded start")
		}
		// The immutable result is authoritative; a missing derived receipt must
		// never let duplicate delivery append another outcome or advance time.
		var existing string
		err := t.conn.QueryRowContext(t.ctx, "SELECT payload FROM cognition_events WHERE work_id=? AND kind='finish' AND json_extract(payload, '$.ticket.id')=?", ticket.WorkID, ticket.ID).Scan(&existing)
		if err == nil {
			var recorded Event
			if err := json.Unmarshal([]byte(existing), &recorded); err != nil {
				return err
			}
			if recorded.Digest != hash {
				return fmt.Errorf("conflicting result for invocation %s", ticket.ID)
			}
			if _, err := t.conn.ExecContext(t.ctx, "INSERT OR REPLACE INTO cognition_receipts(work_id,op_id,digest,seq) VALUES(?,?,?,?)", ticket.WorkID, ticket.ID, hash, recorded.Seq); err != nil {
				return err
			}
			return t.sync() // duplicate delivery never repeats effects or counters
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var active int
		if err := t.conn.QueryRowContext(t.ctx, "SELECT COUNT(*) FROM cognition_active WHERE op_id<>?", ticket.ID).Scan(&active); err != nil {
			return err
		}
		if _, err := t.conn.ExecContext(t.ctx, "DELETE FROM cognition_active WHERE op_id=?", ticket.ID); err != nil {
			return err
		}
		if ticket.Mutating {
			if err := t.advance(); err != nil {
				return err
			}
		}
		if err := t.append(Event{Kind: "finish", Ticket: &ticket, Digest: hash,
			Excerpt: clip(outcome.Output, 512), IsError: failed, Unknown: unknown, ConcurrentMutation: active > 0}); err != nil {
			return err
		}
		_, err = t.conn.ExecContext(t.ctx, "INSERT INTO cognition_receipts(work_id,op_id,digest,seq) VALUES(?,?,?,?)", ticket.WorkID, ticket.ID, hash, t.state.Seq)
		return err
	})
}

// RecordGap acknowledges lost recording after tools have finished. It advances
// the shared clock so other workers cannot retain pre-gap freshness. It never
// changes observer ownership: a late worker may report lost execution without
// replacing the current worker. Repeated acknowledgements are conservative
// invalidations, not replayed tool effects.
func (s *Store) RecordGap(scope Scope) (Snapshot, error) {
	return s.transact(scope, func(t *transaction) error {
		if err := t.advance(); err != nil {
			return err
		}
		return t.append(Event{Kind: "gap"})
	})
}

func (s *Store) View(scope Scope) (Snapshot, error) {
	return s.transact(scope, func(t *transaction) error {
		if err := s.sweepOwners(t); err != nil {
			return err
		}
		return t.sync()
	})
}

// Process death is an observation too. Record it before releasing a workspace
// overlap marker. PID reuse/access errors are conservative: keep uncertainty.
// A shell's surviving descendants remain outside recorded core operations.
func (s *Store) sweepOwners(t *transaction) error {
	rows, err := t.conn.QueryContext(t.ctx, `SELECT e.payload FROM cognition_active a JOIN cognition_events e
ON e.work_id=a.work_id AND e.kind='start' AND json_extract(e.payload,'$.ticket.id')=a.op_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var tickets []Ticket
	for rows.Next() {
		var payload string
		if err = rows.Scan(&payload); err != nil {
			return err
		}
		var e Event
		if err = json.Unmarshal([]byte(payload), &e); err != nil {
			return err
		}
		if e.Ticket != nil && e.Ticket.OwnerPID > 0 {
			tickets = append(tickets, *e.Ticket)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	checked := map[int]bool{}
	sort.Slice(tickets, func(i, j int) bool {
		if tickets[i].WorkID != tickets[j].WorkID {
			return tickets[i].WorkID < tickets[j].WorkID
		}
		return tickets[i].StartSeq < tickets[j].StartSeq
	})
	for _, ticket := range tickets {
		alive, known := checked[ticket.OwnerPID]
		if !known {
			var checkErr error
			alive, checkErr = s.running(ticket.OwnerPID)
			if checkErr != nil {
				alive = true
			}
			checked[ticket.OwnerPID] = alive
		}
		if alive {
			continue
		}
		observed := t
		if ticket.WorkID != t.scope.WorkID {
			observed = &transaction{ctx: t.ctx, conn: t.conn, scope: ticket.Scope, state: NewState(), epoch: t.epoch}
			if err = observed.load(); err != nil {
				if err = observed.restore(); err != nil {
					return err
				}
			}
		}
		originalScope := observed.scope
		observed.scope = ticket.Scope
		if err = observed.advance(); err != nil {
			return err
		}
		if err = observed.append(Event{Kind: "orphan", Ticket: &ticket}); err != nil {
			return err
		}
		observed.scope = originalScope
		t.epoch = observed.epoch
		if _, err = t.conn.ExecContext(t.ctx, "DELETE FROM cognition_active WHERE op_id=?", ticket.ID); err != nil {
			return err
		}
	}
	return nil
}

func canonicalInput(raw json.RawMessage) string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber() // don't collapse distinct integers through float64
	var value any
	if decoder.Decode(&value) == nil {
		var extra any
		if decoder.Decode(&extra) == io.EOF {
			if canonical, err := json.Marshal(value); err == nil {
				return string(canonical)
			}
		}
	}
	return string(raw)
}

func describe(tool, input string) string {
	// Keep operational selectors, not arbitrary write content, in working memory.
	var args map[string]any
	if json.Unmarshal([]byte(input), &args) == nil {
		for _, key := range []string{"path", "command", "pattern", "url", "query"} {
			if value, ok := args[key].(string); ok && value != "" {
				return clip(tool+" "+key+"="+value, 200)
			}
		}
	}
	return clip(tool, 200)
}

func digest(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
