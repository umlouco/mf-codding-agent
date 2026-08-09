package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// EmbeddingClient calls a /v1/embeddings endpoint to turn text into vectors.
type EmbeddingClient struct {
	baseURL string
	apiKey  string
	model   string
	http    *http.Client
}

func NewEmbeddingClient(baseURL, apiKey, model string) *EmbeddingClient {
	return &EmbeddingClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		model:   model,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *EmbeddingClient) Enabled() bool {
	return c != nil && c.model != "" && c.baseURL != ""
}

func (c *EmbeddingClient) Model() string { return c.model }

func (c *EmbeddingClient) Embed(ctx context.Context, text string) ([]float32, error) {
	if !c.Enabled() {
		return nil, fmt.Errorf("embedding client not configured")
	}

	body := map[string]any{
		"model": c.model,
		"input": text,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/embeddings", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedding request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("embedding http %d: %s", resp.StatusCode, string(b))
	}

	var out struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("parsing embedding response: %w", err)
	}
	if len(out.Data) == 0 || len(out.Data[0].Embedding) == 0 {
		return nil, fmt.Errorf("embedding endpoint returned empty vector")
	}
	return out.Data[0].Embedding, nil
}

// embedMany returns a single embedding by joining the texts with newlines and
// embedding them together. This is cheaper than embedding each piece separately
// for simple inputs.
func (c *EmbeddingClient) embedMany(ctx context.Context, texts []string) ([]float32, error) {
	if len(texts) == 0 {
		return nil, fmt.Errorf("no text to embed")
	}
	return c.Embed(ctx, strings.Join(texts, "\n"))
}

// vectorToBlob packs []float32 into a little-endian byte sequence.
func vectorToBlob(v []float32) []byte {
	if len(v) == 0 {
		return nil
	}
	b := make([]byte, len(v)*4)
	for i, f := range v {
		bits := math.Float32bits(f)
		b[i*4+0] = byte(bits)
		b[i*4+1] = byte(bits >> 8)
		b[i*4+2] = byte(bits >> 16)
		b[i*4+3] = byte(bits >> 24)
	}
	return b
}

// blobToVector unpacks a little-endian byte sequence back to []float32.
func blobToVector(b []byte) []float32 {
	if len(b) == 0 || len(b)%4 != 0 {
		return nil
	}
	v := make([]float32, len(b)/4)
	for i := range v {
		bits := uint32(b[i*4]) | uint32(b[i*4+1])<<8 | uint32(b[i*4+2])<<16 | uint32(b[i*4+3])<<24
		v[i] = math.Float32frombits(bits)
	}
	return v
}

// cosineSimilarity returns the cosine between two equal-length float32 slices.
func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	// Divide by the product of the *norms*, not of the squared norms. Without
	// the roots this silently degrades to a different metric — one that happens
	// to agree with cosine when every vector is unit length, which is why it
	// survives against providers that normalise and skews the ranking against
	// those that do not.
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
