package llm

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Keep the response open after its final event: completing the model call must
// not depend on the HTTP server closing a connection that is still alive.
func openStreamServer(t *testing.T, data string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, data)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	return server
}

func TestOpenAIStreamDoneReturnsBeforeConnectionCloses(t *testing.T) {
	server := openStreamServer(t, ": keepalive\n\n"+
		"data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\n"+
		"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"+
		"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":2}}\n\n"+
		"data: [DONE]\n\n")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	provider := NewOpenAICompat(server.URL, "", "local-model", 128, "")
	turn, err := provider.Stream(ctx, Request{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if turn.StopReason != "end_turn" || turn.Usage.Input != 12 || turn.Usage.Output != 2 {
		t.Fatalf("lost completion or trailing usage: %+v", turn)
	}
	if len(turn.Blocks) != 1 || turn.Blocks[0].Text != "OK" {
		t.Fatalf("unexpected blocks: %+v", turn.Blocks)
	}
}

func TestOpenAIStreamErrorsReturnBeforeConnectionCloses(t *testing.T) {
	for _, tc := range []struct{ name, payload, want string }{
		{"object", `{"error":{"message":"context window exceeded","code":400}}`, "context window exceeded"},
		{"string", `{"error":"model failed to load"}`, "model failed to load"},
		{"no_message", `{"error":{"code":500}}`, "provider returned an error without a message"},
		{"malformed", `{"choices":`, "invalid model stream data"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := openStreamServer(t, ": keepalive\n\ndata: "+tc.payload+"\n\n")
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			provider := NewOpenAICompat(server.URL, "", "local-model", 128, "")
			turn, err := provider.Stream(ctx, Request{}, nil)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got turn=%+v err=%v", tc.want, turn, err)
			}
			if turn != nil {
				t.Fatal("a failed stream must not return a successful turn")
			}
		})
	}
}

func TestOpenAIStreamKeepalivesDoNotHideModelOutput(t *testing.T) {
	server := openStreamServer(t, ": keepalive\n\n"+
		"data: {\"error\":null,\"choices\":[{\"delta\":{\"reasoning_content\":\"Checking\"}}]}\n\n"+
		": keepalive\n\n"+
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n"+
		"data: [DONE]\n\n")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	provider := NewOpenAICompat(server.URL, "", "local-model", 128, "")
	seen := map[string]bool{}
	turn, err := provider.Stream(ctx, Request{}, func(ev Event) { seen[ev.Kind] = true })
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{EventWire, EventThinking, EventToolInput, EventToolStart} {
		if !seen[kind] {
			t.Errorf("missing event %s", kind)
		}
	}
	if turn.StopReason != "tool_use" || len(turn.ToolCalls()) != 1 {
		t.Fatalf("tool call lost: %+v", turn)
	}
}
