package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mflores/mfagent/core/internal/agent"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/rpc"
	"github.com/mflores/mfagent/core/internal/tools"
)

// Exercise the actual initialize -> agent -> HTTP boundary: setting queueRole
// used to restrict tools without changing the generic coding system prompt.
func TestSupervisorPromptReachesProviderWithCorrectAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, role, authority string
		inspect, responseOnly bool
	}{
		{"review", "supervisor", "This is an inspection-only supervisor turn.", true, false},
		{"repair", "supervisor-repair", "This is a dedicated supervisor test-repair turn", false, false},
		{"response", "supervisor", "response-only decision turn", true, true},
		{"validator-response", "validator", "You are a skilled software tester", false, true},
		{"executor", "executor", "You are a coding agent embedded", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("MFAGENT_QUEUE_ROLE", os.Getenv("MFAGENT_QUEUE_ROLE"))
			captured := make(chan string, 1)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Messages []struct {
						Role    string `json:"role"`
						Content any    `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Errorf("decode provider request: %v", err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				for _, message := range request.Messages {
					if message.Role == "system" {
						captured <- fmt.Sprint(message.Content)
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Review recorded.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer provider.Close()
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("Preserve the invoice approval boundary."), 0600); err != nil {
				t.Fatal(err)
			}
			s := &server{conn: rpc.NewConn(strings.NewReader(""), io.Discard),
				registry: tools.NewRegistry(), mcpMgr: mcp.NewManager()}
			defer s.shutdown()
			input, err := json.Marshal(map[string]any{
				"workspaceRoot": root, "queueRole": tc.role, "inspectOnly": tc.inspect,
				"responseOnly": tc.responseOnly, "memoryEnabled": false,
				"languages": []string{"Go"}, "skillsText": "# Skills\nInspect invoice state transitions.",
				"providers": []map[string]any{{"id": "test", "type": "openai-compatible", "baseURL": provider.URL, "enabled": true}},
				"coding":    map[string]string{"providerId": "test", "model": "test-model"},
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := s.onInitialize(ctx, input); err != nil {
				t.Fatal(err)
			}
			if _, err := s.ag.Send(ctx, agent.SendRequest{SessionID: "review", Text: "Review the supplied evidence."}); err != nil {
				t.Fatal(err)
			}
			var system string
			select {
			case system = <-captured:
			default:
				t.Fatal("provider received no system message")
			}
			if !strings.Contains(system, tc.authority) {
				t.Fatalf("provider did not receive %s authority: %s", tc.name, system)
			}
			if tc.role != "executor" {
				for _, forbidden := range []string{"You are a coding agent embedded", "Use this workflow for coding tasks", "memory_remember"} {
					if strings.Contains(system, forbidden) {
						t.Errorf("supervisor inherited generic coding instructions: %q", forbidden)
					}
				}
				if tc.role != "validator" && !strings.Contains(system, "engineering supervisor") {
					t.Error("supervisor identity was lost at the provider boundary")
				}
			}
			if !tc.responseOnly {
				for _, preserved := range []string{root, "Go", "Preserve the invoice approval boundary.", "Inspect invoice state transitions."} {
					if !strings.Contains(system, preserved) {
						t.Errorf("workspace context lost: %q", preserved)
					}
				}
			}
		})
	}
}
