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

func TestLocalTemplateJoinsContextWithoutBreakingToolProtocol(t *testing.T) {
	request := Request{System: "system", Messages: []Message{
		UserText("owner request"), UserText("runtime observations"),
		{Role: RoleAssistant, Blocks: []Block{{Type: BlockToolUse, ID: "call1", Name: "read_file", Input: json.RawMessage(`{"path":"main.go"}`)}}},
		{Role: RoleUser, Blocks: []Block{{Type: BlockToolResult, ToolUseID: "call1", Text: "source"}}},
		UserText("next request"),
		{Role: RoleUser, Blocks: []Block{{Type: BlockImage, MediaType: "image/png", Data: "aW1hZ2U="}}},
	}}
	messages := newTestProvider("").convert(request)
	if len(messages) != 5 || messages[1].Content != "owner request\n\nruntime observations" {
		t.Fatalf("context was not merged: %#v", messages)
	}
	if messages[2].Role != "assistant" || messages[3].Role != "tool" || messages[3].ToolCallID != "call1" {
		t.Fatalf("tool protocol changed: %#v", messages)
	}
	parts := messages[4].Content.([]map[string]any)
	if len(parts) != 3 || parts[0]["text"] != "next request" || parts[2]["type"] != "image_url" {
		t.Fatalf("multimodal content lost: %#v", parts)
	}
}

func TestToolArgumentProgressCountsBytesWithoutExposingContents(t *testing.T) {
	input := `{"content":"private argument value"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		var chunks []string
		for _, fragment := range []string{input[:10], input[10:]} {
			encoded, _ := json.Marshal(fragment)
			chunks = append(chunks, fmt.Sprintf(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"write_file","arguments":%s}}]}}]}`, encoded))
		}
		_, _ = w.Write([]byte(sse(chunks...)))
	}))
	defer srv.Close()
	var bytes, fragments int
	turn, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, func(ev Event) {
		if ev.Kind == EventToolInput {
			if ev.Text != "" {
				t.Error("raw arguments exposed in progress")
			}
			bytes += ev.Bytes
			fragments++
		}
	})
	if err != nil || bytes != len(input) || fragments != 2 {
		t.Fatalf("bytes=%d fragments=%d err=%v", bytes, fragments, err)
	}
	if len(turn.Blocks) != 1 || string(turn.Blocks[0].Input) != input {
		t.Fatal("argument assembly changed")
	}
}

func TestThinkingSurvivesToolContinuationOnlyInObservedField(t *testing.T) {
	for _, field := range []string{"reasoning_content", "reasoning"} {
		t.Run(field, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, sse(fmt.Sprintf(`{"choices":[{"delta":{%q:"retained reasoning"}}]}`, field),
					`{"choices":[{"delta":{"content":"Checking now","tool_calls":[{"index":0,"id":"call1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`))
			}))
			defer srv.Close()
			provider := newTestProvider(srv.URL)
			turn, err := provider.Stream(context.Background(), Request{}, nil)
			if err != nil || turn.Text() != "Checking now" {
				t.Fatalf("turn=%+v err=%v", turn, err)
			}
			messages := []Message{UserText("owner request"), {Role: RoleAssistant, Blocks: turn.Blocks},
				{Role: RoleUser, Blocks: []Block{{Type: BlockToolResult, ToolUseID: "call1", Text: "source"}}}}
			converted := provider.convert(Request{Messages: messages})
			raw, _ := json.Marshal(converted[1])
			var assistant map[string]any
			json.Unmarshal(raw, &assistant)
			if assistant[field] != "retained reasoning" || assistant["content"] != "Checking now" {
				t.Fatalf("continuation lost reasoning or leaked it: %s", raw)
			}
			messages = append(messages, UserText("new owner request"))
			converted = provider.convert(Request{Messages: messages})
			if converted[1].ReasoningContent != "" || converted[1].Reasoning != "" {
				t.Fatal("old-turn reasoning carried into new user turn")
			}
		})
	}
}

func TestTruncatedStreamCannotBecomeCompletedTurn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial answer\"}}]}\n\n")
	}))
	defer srv.Close()
	turn, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, nil)
	if err == nil || turn != nil || !strings.Contains(err.Error(), "without a completion marker") {
		t.Fatalf("turn=%+v err=%v", turn, err)
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
	if turn.Usage.ContextTokens() != 1200 {
		t.Fatalf("context = %d, want 1200 (cache is already included)", turn.Usage.ContextTokens())
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

// reasoning_effort is what lets a reasoning model routed through OpenRouter,
// or OpenAI directly, be told how hard to think — but only when a role
// actually asked for it. Sending it unconditionally would break the strict
// local servers stream_options already has to work around.
func TestStreamSendsReasoningEffortWhenConfigured(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sse(`{"choices":[{"delta":{"content":"ok"}}]}`)))
	}))
	defer srv.Close()

	p := newTestProvider(srv.URL)
	p.effort = "high"
	if _, err := p.Stream(context.Background(), Request{}, nil); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if body["reasoning_effort"] != "high" {
		t.Errorf("reasoning_effort = %v, want %q", body["reasoning_effort"], "high")
	}
}

func TestStreamOmitsReasoningEffortByDefault(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sse(`{"choices":[{"delta":{"content":"ok"}}]}`)))
	}))
	defer srv.Close()

	if _, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, nil); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if _, present := body["reasoning_effort"]; present {
		t.Errorf("reasoning_effort should be omitted when no role configured one, got %v", body["reasoning_effort"])
	}
}

// A strict server that 4xxs on reasoning_effort must still get an answer,
// exactly like the stream_options case above — the retry logic covers both.
func TestStreamRetriesWithoutReasoningEffortOnRejection(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, asked := body["reasoning_effort"]; asked {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"unrecognized field reasoning_effort"}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(sse(`{"choices":[{"delta":{"content":"still works"}}]}`)))
	}))
	defer srv.Close()

	p := newTestProvider(srv.URL)
	p.effort = "high"
	turn, err := p.Stream(context.Background(), Request{}, nil)
	if err != nil {
		t.Fatalf("a server rejecting reasoning_effort must still answer: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2 (with, then without)", attempts)
	}
	if turn.Text() != "still works" {
		t.Errorf("text = %q, want %q", turn.Text(), "still works")
	}
}

// DeepSeek's own API (and some local servers) stream reasoning under
// "reasoning_content"; OpenRouter normalises every backend it fronts —
// including that same DeepSeek model — to a bare "reasoning" instead. Missing
// either spelling means that provider's entire reasoning stream is silently
// dropped: not shown as thinking, not counted, gone, while the connection
// stays busy for however long the model spends thinking.
func TestStreamCollectsReasoningUnderEitherFieldName(t *testing.T) {
	for _, tc := range []struct {
		name  string
		field string
	}{
		{"DeepSeek-native", "reasoning_content"},
		{"OpenRouter-normalised", "reasoning"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(sse(
					fmt.Sprintf(`{"choices":[{"delta":{"%s":"thinking a"}}]}`, tc.field),
					fmt.Sprintf(`{"choices":[{"delta":{"%s":"thinking b"}}]}`, tc.field),
					`{"choices":[{"delta":{"content":"the answer"}}]}`,
				)))
			}))
			defer srv.Close()

			var thinking strings.Builder
			turn, err := newTestProvider(srv.URL).Stream(context.Background(), Request{}, func(ev Event) {
				if ev.Kind == EventThinking {
					thinking.WriteString(ev.Text)
				}
			})
			if err != nil {
				t.Fatalf("Stream: %v", err)
			}
			if got := thinking.String(); got != "thinking athinking b" {
				t.Errorf("reasoning collected = %q, want %q", got, "thinking athinking b")
			}
			if turn.Text() != "the answer" {
				t.Errorf("text = %q, want %q — reasoning must not leak into visible content", turn.Text(), "the answer")
			}
		})
	}
}
