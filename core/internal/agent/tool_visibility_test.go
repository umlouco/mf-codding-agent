package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

// Unlike fakeProvider, this provider emits calls even when none were advertised.
// Hiding definitions keeps context small without changing tool availability.
type toolVisibilityProvider struct {
	calls    []llm.Block
	requests []llm.Request
}

func (p *toolVisibilityProvider) Name() string  { return "tool-visibility" }
func (p *toolVisibilityProvider) Model() string { return "tool-visibility-1" }

func (p *toolVisibilityProvider) Stream(_ context.Context, req llm.Request, sink func(llm.Event)) (*llm.Turn, error) {
	p.requests = append(p.requests, req)
	if len(p.requests) == 1 {
		for _, call := range p.calls {
			sink(llm.Event{Kind: llm.EventToolStart, ToolID: call.ID, ToolName: call.Name})
		}
		return &llm.Turn{Blocks: p.calls, StopReason: "tool_use"}, nil
	}
	sink(llm.Event{Kind: llm.EventText, Text: "Review complete."})
	return &llm.Turn{
		Blocks:     []llm.Block{{Type: llm.BlockText, Text: "Review complete."}},
		StopReason: "end_turn",
	}, nil
}

func TestToolVisibilityDoesNotLimitExecution(t *testing.T) {
	for _, tc := range []struct {
		name   string
		hidden bool
	}{
		{name: "advertised"},
		{name: "hidden", hidden: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			provider := &toolVisibilityProvider{calls: []llm.Block{
				{Type: llm.BlockToolUse, ID: "read-1", Name: "read_probe", Input: json.RawMessage(`{}`)},
				{Type: llm.BlockToolUse, ID: "write-1", Name: "write_probe", Input: json.RawMessage(`{}`)},
			}}
			a, log := newLoggedAgent(t, provider, 3)
			a.cfg.DisableTools = tc.hidden
			a.registry = tools.NewRegistry()
			var classified, described, executed [2]int
			for i, call := range provider.calls {
				a.registry.Add(&tools.Tool{
					Name:   call.Name,
					Schema: map[string]any{"type": "object"},
					MutatesOn: func(json.RawMessage) bool {
						classified[i]++
						return i == 1
					},
					Summarize: func(json.RawMessage) string {
						described[i]++
						return call.Name
					},
					Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
						executed[i]++
						return tools.Ok("observed " + call.Name)
					},
				})
			}

			result, err := a.Send(context.Background(), SendRequest{SessionID: "review", Text: "judge evidence"})
			if err != nil {
				t.Fatalf("Send: %v", err)
			}
			if result.Text != "Review complete." || result.StopReason != "end_turn" {
				t.Errorf("result = %+v, want the provider's final answer", result)
			}
			if len(provider.requests) != 2 {
				t.Fatalf("provider requests = %d, want a tool round then a final answer", len(provider.requests))
			}
			wantDefinitions := 2
			if tc.hidden {
				wantDefinitions = 0
			}
			for i, req := range provider.requests {
				if len(req.Tools) != wantDefinitions {
					t.Errorf("request %d advertised %d tools, want %d", i, len(req.Tools), wantDefinitions)
				}
			}
			for i, call := range provider.calls {
				if classified[i] != 1 || described[i] != 1 || executed[i] != 1 {
					t.Errorf("%s callbacks: classified=%d described=%d executed=%d, want 1 each",
						call.Name, classified[i], described[i], executed[i])
				}
			}

			messages := provider.requests[1].Messages
			toolResults := messages[len(messages)-1]
			if toolResults.Role != llm.RoleUser || len(toolResults.Blocks) != len(provider.calls) {
				t.Fatalf("tool result message = %+v, want one paired result per call", toolResults)
			}
			for i, block := range toolResults.Blocks {
				call := provider.calls[i]
				if block.Type != llm.BlockToolResult || block.ToolUseID != call.ID || block.IsError {
					t.Errorf("result for %s = %+v, want a successful result with matching ID", call.ID, block)
				}
				if block.Text != "observed "+call.Name {
					t.Errorf("tool output = %q, want its observed result", block.Text)
				}
			}

			if !log.hasPhase(PhaseTool) {
				t.Error("tool execution was not reported to the activity journal")
			}
			log.mu.Lock()
			defer log.mu.Unlock()
			events := map[string]int{}
			for _, row := range log.rows {
				if row["method"] != "stream/tool" {
					continue
				}
				id, _ := row["id"].(string)
				status, _ := row["status"].(string)
				events[id+":"+status]++
				if status == "error" {
					t.Errorf("successful tool reported an error: %+v", row)
				}
			}
			for _, call := range provider.calls {
				for _, status := range []string{"start", "running", "ok"} {
					if got := events[call.ID+":"+status]; got != 1 {
						t.Errorf("%s events for %s = %d, want 1", status, call.ID, got)
					}
				}
			}
		})
	}
}
