package memory

import (
	"path/filepath"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "memory.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestUpsertMergesRatherThanOverwrites(t *testing.T) {
	s := open(t)

	first, err := s.UpsertNode("File", "src/Cart.php", "The shopping cart.", map[string]any{"lang": "php"})
	if err != nil {
		t.Fatal(err)
	}

	// A later mention with no summary must not erase the one we already have.
	second, err := s.UpsertNode("File", "src/Cart.php", "", map[string]any{"owner": "billing"})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Fatalf("upsert created a duplicate node: %d != %d", second.ID, first.ID)
	}

	got, err := s.GetNode(first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Summary != "The shopping cart." {
		t.Errorf("summary was clobbered: %q", got.Summary)
	}
	if got.Props["lang"] != "php" || got.Props["owner"] != "billing" {
		t.Errorf("props should merge, got %#v", got.Props)
	}
}

// TestSearchExpandsOneHop is the core claim of the tier-2 design: an entity
// that never mentions the search terms is still surfaced when it is connected
// to one that does.
func TestSearchExpandsOneHop(t *testing.T) {
	s := open(t)

	gateway, err := s.UpsertNode("Module", "StripeGateway", "Talks to the Stripe API.", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately shares no vocabulary with the query.
	retry, err := s.UpsertNode("Decision", "exponential-backoff-policy",
		"Retries use exponential backoff capped at 30 seconds.", nil)
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := s.UpsertNode("Module", "PdfExporter", "Renders invoices to PDF.", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AddEdge(gateway.ID, retry.ID, "documents", 1.0, nil); err != nil {
		t.Fatal(err)
	}

	hits, err := s.Search("Stripe", 10, true)
	if err != nil {
		t.Fatal(err)
	}

	found := map[string]bool{}
	for _, h := range hits {
		found[h.Node.Name] = true
	}
	if !found["StripeGateway"] {
		t.Fatal("the directly matching entity was not returned")
	}
	if !found["exponential-backoff-policy"] {
		t.Error("one-hop expansion did not surface the connected entity")
	}
	if found["PdfExporter"] {
		t.Error("an unconnected, unmatching entity should not be returned")
	}
	_ = unrelated

	// Without expansion, only the direct match comes back.
	narrow, err := s.Search("Stripe", 10, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range narrow {
		if h.Node.Name == "exponential-backoff-policy" {
			t.Error("expansion was disabled but the neighbour still appeared")
		}
	}
}

func TestSearchMatchesObservations(t *testing.T) {
	s := open(t)
	n, err := s.UpsertNode("Module", "auth", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddObservation(n.ID, "Sessions are stored in Redis with a 14 day TTL.", "agent", "s1"); err != nil {
		t.Fatal(err)
	}

	hits, err := s.Search("redis TTL", 5, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 || hits[0].Node.Name != "auth" {
		t.Fatalf("observation text should be searchable, got %#v", hits)
	}
	if len(hits[0].Obs) == 0 {
		t.Error("the matching observation should be attached to the hit")
	}
}

func TestTraverseRespectsDepthDirectionAndFilter(t *testing.T) {
	s := open(t)
	mk := func(name string) int64 {
		n, err := s.UpsertNode("Module", name, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		return n.ID
	}
	a, b, c, d := mk("A"), mk("B"), mk("C"), mk("D")
	for _, e := range []struct {
		src, dst int64
		rel      string
	}{
		{a, b, "depends_on"},
		{b, c, "depends_on"},
		{c, d, "depends_on"},
		{a, d, "documents"},
	} {
		if err := s.AddEdge(e.src, e.dst, e.rel, 1.0, nil); err != nil {
			t.Fatal(err)
		}
	}

	names := func(steps []PathStep) map[string]int {
		out := map[string]int{}
		for _, s := range steps {
			out[s.Node.Name] = s.Depth
		}
		return out
	}

	deep, err := s.Traverse(a, 3, nil, "out", 50)
	if err != nil {
		t.Fatal(err)
	}
	got := names(deep)
	if got["B"] != 1 || got["C"] != 2 {
		t.Errorf("unexpected depths: %#v", got)
	}

	shallow, err := s.Traverse(a, 1, nil, "out", 50)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := names(shallow)["C"]; ok {
		t.Error("depth 1 should not reach C")
	}

	filtered, err := s.Traverse(a, 3, []string{"documents"}, "out", 50)
	if err != nil {
		t.Fatal(err)
	}
	f := names(filtered)
	if _, ok := f["B"]; ok {
		t.Error("relation filter should have excluded the depends_on edge")
	}
	if _, ok := f["D"]; !ok {
		t.Error("relation filter should have kept the documents edge")
	}

	incoming, err := s.Traverse(b, 1, nil, "in", 50)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := names(incoming)["A"]; !ok {
		t.Error("inbound traversal should find A")
	}
	if _, ok := names(incoming)["C"]; ok {
		t.Error("inbound traversal should not find C")
	}
}

func TestTraverseHandlesCycles(t *testing.T) {
	s := open(t)
	a, _ := s.UpsertNode("Module", "A", "", nil)
	b, _ := s.UpsertNode("Module", "B", "", nil)
	_ = s.AddEdge(a.ID, b.ID, "depends_on", 1.0, nil)
	_ = s.AddEdge(b.ID, a.ID, "depends_on", 1.0, nil)

	steps, err := s.Traverse(a.ID, 6, nil, "both", 100)
	if err != nil {
		t.Fatalf("a cycle must not hang or error: %v", err)
	}
	for _, st := range steps {
		if st.Node.ID == a.ID {
			t.Error("the seed node should not be revisited")
		}
	}
}

func TestFtsQueryEscapesUserText(t *testing.T) {
	s := open(t)
	if _, err := s.UpsertNode("Concept", "quoting", "handles \"quotes\" fine", nil); err != nil {
		t.Fatal(err)
	}
	// These all contain FTS5 syntax characters and must not produce an error.
	for _, q := range []string{`"unbalanced`, `a OR (b`, `NEAR/2`, `foo*bar`, `--`, `''`} {
		if _, err := s.Search(q, 5, true); err != nil {
			t.Errorf("Search(%q) errored: %v", q, err)
		}
	}
}

func TestForgetRemovesNodeAndCascades(t *testing.T) {
	s := open(t)
	n, _ := s.UpsertNode("Bug", "flaky-test", "Sometimes fails on CI.", nil)
	other, _ := s.UpsertNode("Module", "ci", "", nil)
	_ = s.AddEdge(n.ID, other.ID, "part_of", 1.0, nil)
	_, _ = s.AddObservation(n.ID, "Reproduces roughly one run in twenty.", "agent", "s1")

	removed, err := s.Forget("Bug", "flaky-test")
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("expected to remove 1 node, removed %d", removed)
	}

	stats, err := s.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Nodes != 1 || stats.Edges != 0 || stats.Observations != 0 {
		t.Errorf("cascade incomplete: %+v", stats)
	}
	// The dropped observation must not linger in the search index.
	hits, _ := s.Search("Reproduces", 5, false)
	if len(hits) != 0 {
		t.Errorf("forgotten content is still searchable: %#v", hits)
	}
}

func TestStatsAndGraphView(t *testing.T) {
	s := open(t)
	a, _ := s.UpsertNode("File", "a.go", "", nil)
	b, _ := s.UpsertNode("Symbol", "DoThing", "", nil)
	_ = s.AddEdge(b.ID, a.ID, "defines", 1.0, nil)

	st, err := s.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if st.Nodes != 2 || st.Edges != 1 {
		t.Errorf("unexpected stats: %+v", st)
	}
	if st.ByKind["File"] != 1 || st.ByRel["defines"] != 1 {
		t.Errorf("unexpected breakdown: %+v", st)
	}

	view, err := s.GraphView(50)
	if err != nil {
		t.Fatal(err)
	}
	if len(view["nodes"].([]map[string]any)) != 2 {
		t.Error("graph view should include both nodes")
	}
	if len(view["edges"].([]map[string]any)) != 1 {
		t.Error("graph view should include the edge")
	}
}

func TestPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "memory.db")

	s1, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s1.UpsertNode("Decision", "use-sqlite", "No cgo, cross-compiles cleanly.", nil); err != nil {
		t.Fatal(err)
	}
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopening the store failed: %v", err)
	}
	defer s2.Close()

	hits, err := s2.Search("cgo cross-compiles", 5, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("memory did not survive a restart")
	}
	if hits[0].Node.Name != "use-sqlite" {
		t.Errorf("unexpected hit: %s", hits[0].Node.Name)
	}
}
