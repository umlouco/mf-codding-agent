// Package memory implements the agent's persistent graph memory.
//
// The design follows the three tiers described in "From Vector Stores to Graph
// Memory", collapsed onto one embedded store:
//
//	Tier 1 (episodic)  — observations: append-only lessons and facts, each
//	                     attached to an entity. Cheap to write, keyword-scored.
//	Tier 2 (retrieval) — hybrid FTS5 seed retrieval followed by one-hop graph
//	                     expansion, which recovers bridging evidence that a
//	                     flat keyword or vector search cannot.
//	Tier 3 (substrate) — a real property graph with typed nodes and typed,
//	                     weighted edges, queried by arbitrary-depth traversal.
//
// Storage is a single SQLite file via a pure-Go driver: no server, no cgo, and
// one database per workspace.
package memory

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// NodeKindsDoc is the closed label set. Keeping it closed keeps the graph
// queryable — an open-ended label space degrades into a bag of strings.
const NodeKindsDoc = "File, Symbol, Module, Concept, Decision, Lesson, Requirement, Bug, Task, Person, Service, Endpoint, Table"

// RelKindsDoc is the edge vocabulary.
const RelKindsDoc = "depends_on, calls, defines, implements, part_of, related_to, causes, fixes, supersedes, documents, owns, uses, tested_by, blocks"

type Store struct {
	db   *sql.DB
	path string
	emb  *EmbeddingClient

	// Warn reports a degraded condition to the editor. Optional: a nil Warn
	// means the store is running somewhere with nowhere to report, such as a
	// test.
	Warn func(string)

	warnMu   sync.Mutex
	warnedAt map[string]time.Time
}

type Node struct {
	ID        int64          `json:"id"`
	Kind      string         `json:"kind"`
	Name      string         `json:"name"`
	Summary   string         `json:"summary,omitempty"`
	Props     map[string]any `json:"props,omitempty"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt int64          `json:"updatedAt"`
	Hits      int            `json:"hits"`
}

type Edge struct {
	ID     int64          `json:"id"`
	Src    int64          `json:"src"`
	Dst    int64          `json:"dst"`
	Rel    string         `json:"rel"`
	Weight float64        `json:"weight"`
	Props  map[string]any `json:"props,omitempty"`
}

type Observation struct {
	ID          int64    `json:"id"`
	NodeID      int64    `json:"nodeId"`
	Body        string   `json:"body"`
	Source      string   `json:"source,omitempty"`
	Session     string   `json:"session,omitempty"`
	Confidence  float64  `json:"confidence"`
	Tags        []string `json:"tags,omitempty"`
	UsageCount  int      `json:"usageCount"`
	CreatedAt   int64    `json:"createdAt"`
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	// _pragma args are honoured by modernc.org/sqlite via the DSN.
	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// WAL allows one writer plus concurrent readers. A small pool (rather than
	// a single connection) means a query issued while another cursor is open
	// runs slowly instead of deadlocking outright; busy_timeout absorbs the
	// write contention, and the agent is not write-heavy.
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)

	s := &Store{db: db, path: path}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }
func (s *Store) Path() string { return s.path }

// SetEmbedder attaches an optional embedding client for hybrid vector+FTS5
// retrieval and automatic vector generation on writes.
func (s *Store) SetEmbedder(emb *EmbeddingClient) { s.emb = emb }

/*
embedOrWarn returns a vector for text, reporting a failure instead of hiding it.

Every embedding call site used to read `if err == nil`, so a wrong model name, a
stopped server or a base URL missing its /v1 produced exactly the same outcome
as success: no vector, no message, and a store that quietly downgraded to
keyword-only search. The only symptom was an absence — no requests arriving at
the embedding server — which is indistinguishable from "the agent never wrote a
memory".

Identical failures are reported at most once a minute: a batch of memory writes
against a stopped server would otherwise repeat the same line dozens of times.
*/
func (s *Store) embedOrWarn(ctx context.Context, what, text string) []byte {
	if s.emb == nil || !s.emb.Enabled() {
		return nil
	}
	vec, err := s.emb.Embed(ctx, text)
	if err != nil {
		s.warn(fmt.Sprintf("embedding failed while %s: %v", what, err))
		return nil
	}
	if len(vec) == 0 {
		s.warn(fmt.Sprintf("embedding returned an empty vector while %s", what))
		return nil
	}
	return vectorToBlob(vec)
}

func (s *Store) warn(msg string) {
	if s.Warn == nil {
		return
	}
	s.warnMu.Lock()
	if s.warnedAt == nil {
		s.warnedAt = map[string]time.Time{}
	}
	last, seen := s.warnedAt[msg]
	if seen && time.Since(last) < time.Minute {
		s.warnMu.Unlock()
		return
	}
	s.warnedAt[msg] = time.Now()
	s.warnMu.Unlock()

	s.Warn(msg)
}

// HasEmbedder reports whether vector search is actually available, so callers
// can tell "configured" apart from "working".
func (s *Store) HasEmbedder() bool { return s.emb != nil && s.emb.Enabled() }

const schema = `
CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  summary    TEXT    NOT NULL DEFAULT '',
  props      TEXT    NOT NULL DEFAULT '{}',
  vec        BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY,
  src        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel        TEXT    NOT NULL,
  weight     REAL    NOT NULL DEFAULT 1.0,
  props      TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(src, dst, rel)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS observations (
  id           INTEGER PRIMARY KEY,
  node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT '',
  session      TEXT    NOT NULL DEFAULT '',
  vec          BLOB,
  confidence   REAL    NOT NULL DEFAULT 0.5,
  tags         TEXT    NOT NULL DEFAULT '[]',
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS obs_node ON observations(node_id);

-- A distilled, reusable lesson extracted from agent experience. The reflection
-- step runs after a verified task and produces a structured takeaway so the
-- agent improves session over session.
CREATE TABLE IF NOT EXISTS lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '[]',
  tags        TEXT    NOT NULL DEFAULT '[]',
  confidence  REAL    NOT NULL DEFAULT 0.5,
  source      TEXT    NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One external-content FTS index over both nodes and observations. Rows are
-- keyed by "n:<id>" / "o:<id>" so a single query seeds from either tier.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(ref UNINDEXED, title, body);
`

// alterTry runs a statement and discards any error — SQLite has no IF NOT
// EXISTS for ALTER TABLE, so this is how we add columns to a database that was
// created by an earlier version of the schema.
func alterTry(db *sql.DB, stmt string) {
	_, _ = db.Exec(stmt)
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}

	// Columns added after the initial release — try each one so existing
	// databases pick them up without forcing a rebuild.
	alterTry(s.db, `ALTER TABLE nodes ADD COLUMN vec BLOB`)

	alterTry(s.db, `ALTER TABLE observations ADD COLUMN vec BLOB`)
	alterTry(s.db, `ALTER TABLE observations ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5`)
	alterTry(s.db, `ALTER TABLE observations ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`)
	alterTry(s.db, `ALTER TABLE observations ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`)

	return nil
}

func now() int64 { return time.Now().Unix() }

func marshalProps(p map[string]any) string {
	if len(p) == 0 {
		return "{}"
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func unmarshalProps(s string) map[string]any {
	if s == "" || s == "{}" {
		return nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(s), &m) != nil {
		return nil
	}
	return m
}

func (s *Store) reindexNode(id int64, name, summary string) error {
	ref := fmt.Sprintf("n:%d", id)
	if _, err := s.db.Exec(`DELETE FROM search WHERE ref = ?`, ref); err != nil {
		return err
	}
	_, err := s.db.Exec(`INSERT INTO search(ref, title, body) VALUES(?,?,?)`, ref, name, summary)
	return err
}

// UpsertNode creates or updates a node identified by (kind, name).
func (s *Store) UpsertNode(kind, name, summary string, props map[string]any) (*Node, error) {
	kind = strings.TrimSpace(kind)
	name = strings.TrimSpace(name)
	if kind == "" || name == "" {
		return nil, fmt.Errorf("node kind and name are required")
	}
	t := now()
	var id int64

	// Generate a vector for the node if an embedder is available.
	vecBytes := s.embedOrWarn(context.Background(), "recording entity "+name, name+"\n"+summary)

	err := s.db.QueryRow(`SELECT id FROM nodes WHERE kind = ? AND name = ?`, kind, name).Scan(&id)
	switch {
	case err == sql.ErrNoRows:
		res, err := s.db.Exec(
			`INSERT INTO nodes(kind,name,summary,props,vec,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
			kind, name, summary, marshalProps(props), vecBytes, t, t)
		if err != nil {
			return nil, err
		}
		id, _ = res.LastInsertId()
	case err != nil:
		return nil, err
	default:
		// Merge rather than replace: a later mention with no summary should
		// not wipe an earlier one.
		var oldSummary, oldProps string
		if err := s.db.QueryRow(`SELECT summary, props FROM nodes WHERE id = ?`, id).
			Scan(&oldSummary, &oldProps); err != nil {
			return nil, err
		}
		if summary == "" {
			summary = oldSummary
		}
		merged := unmarshalProps(oldProps)
		if merged == nil {
			merged = map[string]any{}
		}
		for k, v := range props {
			merged[k] = v
		}
		if _, err := s.db.Exec(`UPDATE nodes SET summary=?, props=?, updated_at=? WHERE id=?`,
			summary, marshalProps(merged), t, id); err != nil {
			return nil, err
		}
		// Refresh the vector when the summary changes.
		if vecBytes != nil {
			_, _ = s.db.Exec(`UPDATE nodes SET vec=? WHERE id=?`, vecBytes, id)
		}
		props = merged
	}
	if err := s.reindexNode(id, name, summary); err != nil {
		return nil, err
	}
	return &Node{ID: id, Kind: kind, Name: name, Summary: summary, Props: props,
		CreatedAt: t, UpdatedAt: t}, nil
}

func (s *Store) GetNode(id int64) (*Node, error) {
	n := &Node{}
	var props string
	err := s.db.QueryRow(
		`SELECT id,kind,name,summary,props,created_at,updated_at,hits FROM nodes WHERE id=?`, id).
		Scan(&n.ID, &n.Kind, &n.Name, &n.Summary, &props, &n.CreatedAt, &n.UpdatedAt, &n.Hits)
	if err != nil {
		return nil, err
	}
	n.Props = unmarshalProps(props)
	return n, nil
}

// FindNode resolves a node by exact (kind, name), or by name alone when kind
// is empty and the name is unambiguous.
func (s *Store) FindNode(kind, name string) (*Node, error) {
	var row *sql.Row
	if kind != "" {
		row = s.db.QueryRow(
			`SELECT id,kind,name,summary,props,created_at,updated_at,hits FROM nodes WHERE kind=? AND name=?`,
			kind, name)
	} else {
		row = s.db.QueryRow(
			`SELECT id,kind,name,summary,props,created_at,updated_at,hits FROM nodes WHERE name=? ORDER BY hits DESC LIMIT 1`,
			name)
	}
	n := &Node{}
	var props string
	if err := row.Scan(&n.ID, &n.Kind, &n.Name, &n.Summary, &props,
		&n.CreatedAt, &n.UpdatedAt, &n.Hits); err != nil {
		return nil, err
	}
	n.Props = unmarshalProps(props)
	return n, nil
}

func (s *Store) AddEdge(srcID, dstID int64, rel string, weight float64, props map[string]any) error {
	if rel == "" {
		return fmt.Errorf("relation type is required")
	}
	if weight == 0 {
		weight = 1.0
	}
	_, err := s.db.Exec(
		`INSERT INTO edges(src,dst,rel,weight,props,created_at) VALUES(?,?,?,?,?,?)
		 ON CONFLICT(src,dst,rel) DO UPDATE SET weight=excluded.weight, props=excluded.props`,
		srcID, dstID, rel, weight, marshalProps(props), now())
	return err
}

func (s *Store) AddObservation(nodeID int64, body, source, session string) (int64, error) {
	return s.addObservation(nodeID, body, source, session, 0.5, nil)
}

// AddObservationWithMeta stores an observation with a confidence score and
// free-form tags for later retrieval and lesson extraction.
func (s *Store) AddObservationWithMeta(nodeID int64, body, source, session string, confidence float64, tags []string) (int64, error) {
	return s.addObservation(nodeID, body, source, session, confidence, tags)
}

func (s *Store) addObservation(nodeID int64, body, source, session string, confidence float64, tags []string) (int64, error) {
	if confidence <= 0 {
		confidence = 0.5
	}
	tagJSON := "[]"
	if len(tags) > 0 {
		b, _ := json.Marshal(tags)
		tagJSON = string(b)
	}

	vecBytes := s.embedOrWarn(context.Background(), "recording an observation", body)

	res, err := s.db.Exec(
		`INSERT INTO observations(node_id,body,source,session,vec,confidence,tags,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		nodeID, body, source, session, vecBytes, confidence, tagJSON, now())
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	_, err = s.db.Exec(`INSERT INTO search(ref,title,body) VALUES(?,?,?)`,
		fmt.Sprintf("o:%d", id), "", body)
	return id, err
}

// RecordObservationUsage increments the usage counter on an observation. The
// caller (memory_recall) calls this for each observation it returns, so the
// model naturally learns which facts were useful.
func (s *Store) RecordObservationUsage(id int64) {
	_, _ = s.db.Exec(`UPDATE observations SET usage_count = usage_count + 1 WHERE id = ?`, id)
}

func (s *Store) Observations(nodeID int64, limit int) ([]Observation, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.Query(
		`SELECT id,node_id,body,source,session,confidence,tags,usage_count,created_at FROM observations
		 WHERE node_id=? ORDER BY created_at DESC LIMIT ?`, nodeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Observation
	for rows.Next() {
		var o Observation
		var tagJSON string
		if err := rows.Scan(&o.ID, &o.NodeID, &o.Body, &o.Source, &o.Session,
			&o.Confidence, &tagJSON, &o.UsageCount, &o.CreatedAt); err != nil {
			return nil, err
		}
		if tagJSON != "" && tagJSON != "[]" {
			json.Unmarshal([]byte(tagJSON), &o.Tags)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ---- retrieval ---------------------------------------------------------

type SearchHit struct {
	Node     *Node         `json:"node"`
	Score    float64       `json:"score"`
	Why      string        `json:"why"`
	Obs      []Observation `json:"observations,omitempty"`
	Neighbors []Neighbor   `json:"neighbors,omitempty"`
}

type Neighbor struct {
	Rel       string `json:"rel"`
	Direction string `json:"direction"` // "out" or "in"
	Node      *Node  `json:"node"`
}

// ftsQuery turns free text into an FTS5 OR query. Bare user text can contain
// characters FTS5 treats as syntax, so every term is quoted.
func ftsQuery(q string) string {
	fields := strings.FieldsFunc(q, func(r rune) bool {
		return !(r == '_' || r == '.' || r == '/' || r == '-' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
	})
	var terms []string
	for _, f := range fields {
		if len(f) < 2 {
			continue
		}
		terms = append(terms, `"`+strings.ReplaceAll(f, `"`, `""`)+`"*`)
	}
	if len(terms) == 0 {
		return ""
	}
	return strings.Join(terms, " OR ")
}

// Search runs the tier-2 retrieval: FTS5 seeds, then one hop of graph
// expansion, then a re-rank that rewards nodes reached from several seeds.
func (s *Store) Search(query string, limit int, expand bool) ([]SearchHit, error) {
	if limit <= 0 {
		limit = 8
	}
	fq := ftsQuery(query)
	if fq == "" {
		return nil, nil
	}

	// Seed retrieval. bm25() is ascending-better, so negate it for a score
	// where higher is better.
	rows, err := s.db.Query(
		`SELECT ref, -bm25(search) AS score FROM search WHERE search MATCH ? ORDER BY score DESC LIMIT ?`,
		fq, limit*4)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	// Drain the cursor completely before running any follow-up query. The pool
	// is capped at a single connection, so issuing a query while these rows are
	// still open deadlocks: the inner query waits for the connection the outer
	// cursor is holding.
	type rawHit struct {
		ref   string
		score float64
	}
	var raw []rawHit
	for rows.Next() {
		var h rawHit
		if err := rows.Scan(&h.ref, &h.score); err != nil {
			rows.Close()
			return nil, err
		}
		raw = append(raw, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	seedScore := map[int64]float64{}
	seedWhy := map[int64]string{}
	for _, h := range raw {
		switch {
		case strings.HasPrefix(h.ref, "n:"):
			var id int64
			fmt.Sscanf(h.ref[2:], "%d", &id)
			if id > 0 && h.score > seedScore[id] {
				seedScore[id] = h.score
				seedWhy[id] = "direct match"
			}
		case strings.HasPrefix(h.ref, "o:"):
			var obsID int64
			fmt.Sscanf(h.ref[2:], "%d", &obsID)
			if obsID <= 0 {
				continue
			}
			var nodeID int64
			if s.db.QueryRow(`SELECT node_id FROM observations WHERE id=?`, obsID).
				Scan(&nodeID) == nil && nodeID > 0 {
				// Slightly discount an observation match relative to a match on
				// the entity itself.
				if h.score*0.9 > seedScore[nodeID] {
					seedScore[nodeID] = h.score * 0.9
					seedWhy[nodeID] = "matched an observation"
				}
			}
		}
	}
	if len(seedScore) == 0 {
		return nil, nil
	}

	final := map[int64]float64{}
	why := map[int64]string{}
	for id, sc := range seedScore {
		final[id] = sc
		why[id] = seedWhy[id]
	}

	// Hybrid vector blending. If an embedding provider is configured, compute
	// the query vector and blend cosine similarity with the FTS5 BM25 score so
	// semantic matches that use different vocabulary are still surfaced.
	var hybridWhy map[int64]string
	if s.emb != nil && s.emb.Enabled() && len(seedScore) > 0 {
		qvec, err := s.emb.Embed(context.Background(), query)
		if err != nil {
			s.warn(fmt.Sprintf("embedding failed while searching memory: %v", err))
		}
		if err == nil && len(qvec) > 0 {
			vecScores := s.vectorScoresForSeeds(seedScore, qvec)
			if len(vecScores) > 0 {
				hybridWhy = map[int64]string{}
				// Normalise both distributions so they are comparable, then
				// blend: 60% vector, 40% keyword.
				normBm25 := normalizeScores(seedScore)
				normCos := normalizeScores(vecScores)
				for id := range seedScore {
					final[id] = 0.4*normBm25[id] + 0.6*normCos[id]
					if normCos[id] > normBm25[id] {
						hybridWhy[id] = "semantic match"
					} else {
						hybridWhy[id] = seedWhy[id]
					}
				}
				// Swap in the hybrid reasons.
				for id, w := range hybridWhy {
					why[id] = w
				}
			}
		}
	}

	// One-hop expansion. A node pulled in by two different seeds scores higher
	// than one pulled in by a single seed — this is what surfaces bridging
	// evidence between chunks that never mention each other.
	if expand {
		for id, sc := range seedScore {
			nbrs, err := s.neighbors(id)
			if err != nil {
				continue
			}
			for _, n := range nbrs {
				bonus := sc * 0.35 * clampWeight(n.weight)
				if _, seeded := seedScore[n.node.ID]; seeded {
					continue
				}
				final[n.node.ID] += bonus
				if why[n.node.ID] == "" {
					why[n.node.ID] = fmt.Sprintf("reached via %s", n.rel)
				} else {
					why[n.node.ID] += ", " + n.rel
				}
			}
		}
	}

	ids := make([]int64, 0, len(final))
	for id := range final {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return final[ids[i]] > final[ids[j]] })
	if len(ids) > limit {
		ids = ids[:limit]
	}

	var hits []SearchHit
	for _, id := range ids {
		n, err := s.GetNode(id)
		if err != nil {
			continue
		}
		_, _ = s.db.Exec(`UPDATE nodes SET hits = hits + 1 WHERE id = ?`, id)
		obs, _ := s.Observations(id, 5)
		nbrs, _ := s.neighbors(id)
		var out []Neighbor
		for i, nb := range nbrs {
			if i >= 8 {
				break
			}
			out = append(out, Neighbor{Rel: nb.rel, Direction: nb.dir, Node: nb.node})
		}
		hits = append(hits, SearchHit{Node: n, Score: final[id], Why: why[id], Obs: obs, Neighbors: out})
	}
	return hits, nil
}

func clampWeight(w float64) float64 {
	if w <= 0 {
		return 0.1
	}
	if w > 2 {
		return 2
	}
	return w
}

// vectorScoresForSeeds computes cosine similarity between the query vector and
// each seed node (plus its observations), returning scores keyed by node ID.
func (s *Store) vectorScoresForSeeds(seeds map[int64]float64, qvec []float32) map[int64]float64 {
	out := map[int64]float64{}
	for id := range seeds {
		// Try the node's own vector first.
		var nodeVecBytes []byte
		if err := s.db.QueryRow(`SELECT vec FROM nodes WHERE id = ?`, id).Scan(&nodeVecBytes); err == nil {
			if nv := blobToVector(nodeVecBytes); len(nv) > 0 {
				out[id] = cosineSimilarity(qvec, nv)
				continue
			}
		}
		// Fall back to observation vectors belonging to this node.
		rows, err := s.db.Query(`SELECT vec FROM observations WHERE node_id = ? AND vec IS NOT NULL ORDER BY usage_count DESC LIMIT 5`, id)
		if err != nil {
			continue
		}
		var best float64
		for rows.Next() {
			var ob []byte
			if rows.Scan(&ob) == nil {
				if ov := blobToVector(ob); len(ov) > 0 {
					if sim := cosineSimilarity(qvec, ov); sim > best {
						best = sim
					}
				}
			}
		}
		rows.Close()
		if best > 0 {
			out[id] = best
		}
	}
	return out
}

// normalizeScores rescales a score map to [0, 1] so cosine and BM25
// distributions can be blended on the same axis.
func normalizeScores(scores map[int64]float64) map[int64]float64 {
	if len(scores) == 0 {
		return nil
	}
	var min, max float64
	first := true
	for _, v := range scores {
		if first {
			min, max, first = v, v, false
		} else {
			if v < min {
				min = v
			}
			if v > max {
				max = v
			}
		}
	}
	out := map[int64]float64{}
	span := max - min
	for id, v := range scores {
		if span == 0 {
			out[id] = 0.5
		} else {
			out[id] = (v - min) / span
		}
	}
	return out
}

type nbr struct {
	node   *Node
	rel    string
	dir    string
	weight float64
}

func (s *Store) neighbors(id int64) ([]nbr, error) {
	rows, err := s.db.Query(`
		SELECT n.id, n.kind, n.name, n.summary, n.props, e.rel, e.weight, 'out'
		  FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ?
		UNION ALL
		SELECT n.id, n.kind, n.name, n.summary, n.props, e.rel, e.weight, 'in'
		  FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ?`, id, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []nbr
	for rows.Next() {
		n := &Node{}
		var props, rel, dir string
		var w float64
		if err := rows.Scan(&n.ID, &n.Kind, &n.Name, &n.Summary, &props, &rel, &w, &dir); err != nil {
			return nil, err
		}
		n.Props = unmarshalProps(props)
		out = append(out, nbr{node: n, rel: rel, dir: dir, weight: w})
	}
	return out, rows.Err()
}

// ---- traversal (tier 3) ------------------------------------------------

type PathStep struct {
	Rel       string `json:"rel"`
	Direction string `json:"direction"`
	Node      *Node  `json:"node"`
	Depth     int    `json:"depth"`
}

// Traverse walks the graph breadth-first from a seed node. relFilter, when
// non-empty, restricts which edge types may be followed. direction is
// "out", "in" or "both".
func (s *Store) Traverse(seedID int64, depth int, relFilter []string, direction string, limit int) ([]PathStep, error) {
	if depth <= 0 {
		depth = 2
	}
	if depth > 6 {
		depth = 6
	}
	if limit <= 0 {
		limit = 100
	}
	if direction == "" {
		direction = "both"
	}
	allowed := map[string]bool{}
	for _, r := range relFilter {
		allowed[strings.TrimSpace(r)] = true
	}

	seen := map[int64]bool{seedID: true}
	frontier := []int64{seedID}
	var out []PathStep

	for d := 1; d <= depth && len(frontier) > 0 && len(out) < limit; d++ {
		var next []int64
		for _, id := range frontier {
			nbrs, err := s.neighbors(id)
			if err != nil {
				continue
			}
			for _, n := range nbrs {
				if direction != "both" && n.dir != direction {
					continue
				}
				if len(allowed) > 0 && !allowed[n.rel] {
					continue
				}
				if seen[n.node.ID] {
					continue
				}
				seen[n.node.ID] = true
				out = append(out, PathStep{Rel: n.rel, Direction: n.dir, Node: n.node, Depth: d})
				next = append(next, n.node.ID)
				if len(out) >= limit {
					break
				}
			}
			if len(out) >= limit {
				break
			}
		}
		frontier = next
	}
	return out, nil
}

type Stats struct {
	Path         string         `json:"path"`
	Nodes        int            `json:"nodes"`
	Edges        int            `json:"edges"`
	Observations int            `json:"observations"`
	ByKind       map[string]int `json:"byKind"`
	ByRel        map[string]int `json:"byRel"`
	SizeBytes    int64          `json:"sizeBytes"`
}

func (s *Store) Stats() (*Stats, error) {
	st := &Stats{Path: s.path, ByKind: map[string]int{}, ByRel: map[string]int{}}
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM nodes`).Scan(&st.Nodes)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM edges`).Scan(&st.Edges)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM observations`).Scan(&st.Observations)

	if rows, err := s.db.Query(`SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY 2 DESC`); err == nil {
		for rows.Next() {
			var k string
			var n int
			if rows.Scan(&k, &n) == nil {
				st.ByKind[k] = n
			}
		}
		rows.Close()
	}
	if rows, err := s.db.Query(`SELECT rel, COUNT(*) FROM edges GROUP BY rel ORDER BY 2 DESC`); err == nil {
		for rows.Next() {
			var k string
			var n int
			if rows.Scan(&k, &n) == nil {
				st.ByRel[k] = n
			}
		}
		rows.Close()
	}
	if fi, err := os.Stat(s.path); err == nil {
		st.SizeBytes = fi.Size()
	}
	return st, nil
}

// GraphView returns a bounded subgraph for the UI's visualisation.
func (s *Store) GraphView(limit int) (map[string]any, error) {
	if limit <= 0 {
		limit = 150
	}
	rows, err := s.db.Query(
		`SELECT id,kind,name,summary,hits FROM nodes ORDER BY hits DESC, updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	nodes := []map[string]any{}
	ids := map[int64]bool{}
	for rows.Next() {
		var id int64
		var kind, name, summary string
		var hits int
		if err := rows.Scan(&id, &kind, &name, &summary, &hits); err != nil {
			rows.Close()
			return nil, err
		}
		ids[id] = true
		nodes = append(nodes, map[string]any{
			"id": id, "kind": kind, "name": name, "summary": summary, "hits": hits,
		})
	}
	rows.Close()

	erows, err := s.db.Query(`SELECT src,dst,rel,weight FROM edges`)
	if err != nil {
		return nil, err
	}
	defer erows.Close()
	edges := []map[string]any{}
	for erows.Next() {
		var src, dst int64
		var rel string
		var w float64
		if err := erows.Scan(&src, &dst, &rel, &w); err != nil {
			return nil, err
		}
		if ids[src] && ids[dst] {
			edges = append(edges, map[string]any{"src": src, "dst": dst, "rel": rel, "weight": w})
		}
	}
	return map[string]any{"nodes": nodes, "edges": edges}, nil
}

// ---- lessons ------------------------------------------------------------

// Lesson is a distilled, reusable takeaway extracted by the reflection step.
type Lesson struct {
	ID          int64    `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Content     []string `json:"content"`
	Tags        []string `json:"tags"`
	Confidence  float64  `json:"confidence"`
	Source      string   `json:"source"`
	UsageCount  int      `json:"usageCount"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

// UpsertLesson creates or updates a lesson by title (title is the logical key).
func (s *Store) UpsertLesson(title, description string, content, tags []string, confidence float64, source string) (*Lesson, error) {
	if confidence <= 0 {
		confidence = 0.5
	}
	contentJSON := "[]"
	if len(content) > 0 {
		b, _ := json.Marshal(content)
		contentJSON = string(b)
	}
	tagJSON := "[]"
	if len(tags) > 0 {
		b, _ := json.Marshal(tags)
		tagJSON = string(b)
	}
	t := now()

	var id int64
	err := s.db.QueryRow(`SELECT id FROM lessons WHERE title = ?`, title).Scan(&id)
	switch {
	case err == sql.ErrNoRows:
		res, err := s.db.Exec(
			`INSERT INTO lessons(title,description,content,tags,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
			title, description, contentJSON, tagJSON, confidence, source, t, t)
		if err != nil {
			return nil, err
		}
		id, _ = res.LastInsertId()
	case err != nil:
		return nil, err
	default:
		if _, err := s.db.Exec(
			`UPDATE lessons SET description=?, content=?, tags=?, confidence=?, source=?, updated_at=? WHERE id=?`,
			description, contentJSON, tagJSON, confidence, source, t, id); err != nil {
			return nil, err
		}
	}
	return &Lesson{
		ID: id, Title: title, Description: description, Content: content,
		Tags: tags, Confidence: confidence, Source: source, CreatedAt: t, UpdatedAt: t,
	}, nil
}

// Lessons returns recent lessons, optionally filtered by tags.
func (s *Store) Lessons(tagFilter []string, limit int) ([]Lesson, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.db.Query(
		`SELECT id,title,description,content,tags,confidence,source,usage_count,created_at,updated_at
		 FROM lessons ORDER BY usage_count DESC, confidence DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Lesson
	for rows.Next() {
		var l Lesson
		var contentJSON, tagJSON string
		if err := rows.Scan(&l.ID, &l.Title, &l.Description, &contentJSON, &tagJSON,
			&l.Confidence, &l.Source, &l.UsageCount, &l.CreatedAt, &l.UpdatedAt); err != nil {
			return nil, err
		}
		if contentJSON != "" && contentJSON != "[]" {
			json.Unmarshal([]byte(contentJSON), &l.Content)
		}
		if tagJSON != "" && tagJSON != "[]" {
			json.Unmarshal([]byte(tagJSON), &l.Tags)
		}
		// Filter by tag if requested.
		if len(tagFilter) > 0 && !hasAnyTag(l.Tags, tagFilter) {
			continue
		}
		out = append(out, l)
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

// FindSimilarLessons finds lessons sharing at least one tag with the given set.
func (s *Store) FindSimilarLessons(tags []string, limit int) ([]Lesson, error) {
	return s.Lessons(tags, limit)
}

// RecordLessonUsage bumps the usage counter when a lesson is retrieved.
func (s *Store) RecordLessonUsage(id int64) {
	_, _ = s.db.Exec(`UPDATE lessons SET usage_count = usage_count + 1 WHERE id = ?`, id)
}

// DeleteLesson removes a lesson by id.
func (s *Store) DeleteLesson(id int64) error {
	_, err := s.db.Exec(`DELETE FROM lessons WHERE id = ?`, id)
	return err
}

func hasAnyTag(haystack, needles []string) bool {
	for _, h := range haystack {
		for _, n := range needles {
			if strings.EqualFold(h, n) {
				return true
			}
		}
	}
	return false
}

func (s *Store) Forget(kind, name string) (int, error) {
	res, err := s.db.Exec(`DELETE FROM nodes WHERE kind=? AND name=?`, kind, name)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	// FTS rows for the node and its observations are orphaned by the cascade;
	// clear anything no longer backed by a live row.
	_, _ = s.db.Exec(`DELETE FROM search WHERE ref LIKE 'n:%' AND
		CAST(substr(ref,3) AS INTEGER) NOT IN (SELECT id FROM nodes)`)
	_, _ = s.db.Exec(`DELETE FROM search WHERE ref LIKE 'o:%' AND
		CAST(substr(ref,3) AS INTEGER) NOT IN (SELECT id FROM observations)`)
	return int(n), nil
}
