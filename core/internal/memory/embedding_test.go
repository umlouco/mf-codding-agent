package memory

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCosineSimilarityIsScaleInvariant(t *testing.T) {
	// Cosine measures angle, not length. Scaling a vector must not change it —
	// this is what fails when the norms are not square-rooted.
	a := []float32{1, 2, 3}
	b := []float32{1, 2, 3}

	if got := cosineSimilarity(a, b); math.Abs(got-1) > 1e-6 {
		t.Errorf("identical vectors: got %v, want 1", got)
	}

	scaled := []float32{10, 20, 30}
	if got := cosineSimilarity(a, scaled); math.Abs(got-1) > 1e-6 {
		t.Errorf("parallel vectors of different length: got %v, want 1", got)
	}

	orthogonal := cosineSimilarity([]float32{1, 0}, []float32{0, 1})
	if math.Abs(orthogonal) > 1e-6 {
		t.Errorf("orthogonal vectors: got %v, want 0", orthogonal)
	}

	opposite := cosineSimilarity([]float32{1, 0}, []float32{-1, 0})
	if math.Abs(opposite+1) > 1e-6 {
		t.Errorf("opposed vectors: got %v, want -1", opposite)
	}
}

// Longer documents embed to longer vectors unless the provider normalises. The
// unrooted form divided by the squared norms, which pushed every long vector
// down the ranking regardless of its direction.
func TestCosineSimilarityRanksByAngleNotLength(t *testing.T) {
	query := []float32{1, 1, 0}
	sameDirectionLong := []float32{5, 5, 0} // identical angle, 5x the length
	differentDirection := []float32{1, 0, 0}

	long := cosineSimilarity(query, sameDirectionLong)
	different := cosineSimilarity(query, differentDirection)

	if long <= different {
		t.Errorf("a long vector pointing the same way scored %v, below a short "+
			"vector pointing elsewhere at %v", long, different)
	}
}

func TestEmbedReportsHTTPErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"model not found"}`))
	}))
	defer srv.Close()

	c := NewEmbeddingClient(srv.URL+"/v1", "", "nomic-embed-text")
	_, err := c.Embed(context.Background(), "hello")
	if err == nil {
		t.Fatal("want an error for a 404, got nil")
	}
	if !strings.Contains(err.Error(), "model not found") {
		t.Errorf("error should carry the server's reply, got %q", err)
	}
}

func TestEmbedPostsToTheEmbeddingsPath(t *testing.T) {
	var gotPath, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel = body.Model
		_, _ = w.Write([]byte(`{"data":[{"embedding":[0.1,0.2]}]}`))
	}))
	defer srv.Close()

	c := NewEmbeddingClient(srv.URL+"/v1", "", "nomic-embed-text")
	vec, err := c.Embed(context.Background(), "hello")
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if gotPath != "/v1/embeddings" {
		t.Errorf("posted to %q, want /v1/embeddings", gotPath)
	}
	if gotModel != "nomic-embed-text" {
		t.Errorf("model = %q, want nomic-embed-text", gotModel)
	}
	if len(vec) != 2 {
		t.Errorf("vector length = %d, want 2", len(vec))
	}
}

// A failing embedder must degrade the store, not break it — and must say so.
func TestStoreReportsEmbeddingFailuresAndKeepsWriting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	s := open(t)

	var warnings []string
	s.Warn = func(msg string) { warnings = append(warnings, msg) }
	s.SetEmbedder(NewEmbeddingClient(srv.URL+"/v1", "", "broken-model"))

	node, err := s.UpsertNode("Concept", "retry policy", "how retries work", nil)
	if err != nil {
		t.Fatalf("Upsert should survive a failing embedder: %v", err)
	}
	if node == nil || node.Name != "retry policy" {
		t.Fatal("the entity should still have been written")
	}
	if len(warnings) == 0 {
		t.Fatal("a failing embedder must be reported, not swallowed")
	}
	if !strings.Contains(warnings[0], "embedding failed") {
		t.Errorf("warning = %q, want it to name the embedding failure", warnings[0])
	}

	// Identical failures are rate limited so a batch of writes cannot flood.
	before := len(warnings)
	for i := 0; i < 5; i++ {
		if _, err := s.UpsertNode("Concept", "retry policy", "how retries work", nil); err != nil {
			t.Fatalf("UpsertNode: %v", err)
		}
	}
	if len(warnings) != before {
		t.Errorf("repeated identical failures produced %d extra warnings, want 0",
			len(warnings)-before)
	}
}
