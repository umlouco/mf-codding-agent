package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
Token accounting for every provider except Anthropic depends on one request
field. A streamed completion carries no usage block unless stream_options asks
for it, so forgetting it does not fail — it silently reports zero forever.
*/

func sse(chunks ...string) string {
	var b strings.Builder
	for _, c := range chunks {
		fmt.Fprintf(&b, "data: %s\n\n", c)
	}
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}

func newTestProvider(url string) *OpenAIProvider {
	return &OpenAIProvider{
		baseURL:   url + "/v1",
		model:     "local-model",
		http:      http.DefaultClient,
		maxTokens: 256,
	}
}

func TestStreamAsksForUsageAndRecordsIt(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sse(
			`{"choices":[{"delta":{"content":"hi"}}]}`,
			`{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,`+
				`"prompt_tokens_details":{"cached_tokens":900}}}`,
		)))
	}))
	defer srv.Close()

	turn, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, nil)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	opts, ok := body["stream_options"].(map[string]any)
	if !ok || opts["include_usage"] != true {
		t.Fatalf("request did not ask for usage: stream_options = %v", body["stream_options"])
	}
	if turn.Usage.Input != 1200 || turn.Usage.Output != 34 {
		t.Errorf("usage = %d in / %d out, want 1200 / 34", turn.Usage.Input, turn.Usage.Output)
	}
	if turn.Usage.CacheRead != 900 {
		t.Errorf("cache read = %d, want 900", turn.Usage.CacheRead)
	}
	if turn.Text() != "hi" {
		t.Errorf("text = %q, want %q", turn.Text(), "hi")
	}
}

// Some OpenAI-compatible servers reject fields they do not implement. Asking
// for token counts must never cost the reply.
func TestStreamRetriesWithoutStreamOptionsOnRejection(t *testing.T) {
	var attempts int
	var sawUsageField []bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, asked := body["stream_options"]
		sawUsageField = append(sawUsageField, asked)

		if asked {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"unrecognized field stream_options"}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sse(`{"choices":[{"delta":{"content":"still works"}}]}`)))
	}))
	defer srv.Close()

	turn, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, nil)
	if err != nil {
		t.Fatalf("a server rejecting stream_options must still answer: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2 (with, then without)", attempts)
	}
	if len(sawUsageField) != 2 || !sawUsageField[0] || sawUsageField[1] {
		t.Errorf("field presence per attempt = %v, want [true false]", sawUsageField)
	}
	if turn.Text() != "still works" {
		t.Errorf("text = %q, want %q", turn.Text(), "still works")
	}
}

// A real error must still surface, and from the attempt that is most likely to
// explain it rather than from the probe.
func TestStreamReportsGenuineErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"model 'local-model' not found"}`))
	}))
	defer srv.Close()

	_, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, nil)
	if err == nil {
		t.Fatal("want an error, got nil")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error = %q, want the server's explanation", err)
	}
}

// A 5xx is not a "this field is unsupported" signal, so it must not be retried.
func TestStreamDoesNotRetryServerErrors(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`overloaded`))
	}))
	defer srv.Close()

	if _, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, nil); err == nil {
		t.Fatal("want an error, got nil")
	}
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1", attempts)
	}
}
