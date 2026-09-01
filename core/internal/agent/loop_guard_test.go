package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

func TestFailureLoopIgnoresChangingBrokenInput(t *testing.T) {
	var guard toolFailureLoop
	result := []llm.Block{{IsError: true, Text: "line changed\nSyntaxError: invalid syntax"}}
	for i := 1; i <= repeatedToolFailureLimit; i++ {
		calls := []llm.Block{{Name: "run_shell", Input: json.RawMessage(`{"attempt":` + string(rune('0'+i)) + `}`)}}
		stopped, _ := guard.observe(calls, result)
		if stopped != (i == repeatedToolFailureLimit) {
			t.Fatalf("attempt %d stopped=%v", i, stopped)
		}
	}
}

func TestRepeatedToolFailureStopsEarly(t *testing.T) {
	fake := &fakeProvider{finalText: "Stopped after a repeated tool failure."}
	a := newTestAgent(t, fake, 80)
	a.registry = tools.NewRegistry()
	a.registry.Add(&tools.Tool{
		Name:        "noop",
		Description: "always fails",
		Schema:      map[string]any{"type": "object"},
		Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
			return tools.Errf("SyntaxError: invalid syntax")
		},
	})

	res, err := a.Send(context.Background(), SendRequest{SessionID: "loop", Text: "retry forever"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if fake.calls != repeatedToolFailureLimit+1 {
		t.Fatalf("provider calls=%d, want %d", fake.calls, repeatedToolFailureLimit+1)
	}
	if res.StopReason != "repeated_tool_error" {
		t.Errorf("StopReason=%q, want repeated_tool_error", res.StopReason)
	}
	if res.Iterations != repeatedToolFailureLimit {
		t.Errorf("Iterations=%d, want %d", res.Iterations, repeatedToolFailureLimit)
	}
	if !strings.Contains(res.Text, "repeated tool failure") {
		t.Errorf("Text=%q, want stop reason in report", res.Text)
	}
}
