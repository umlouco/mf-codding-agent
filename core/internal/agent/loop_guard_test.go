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
	if strings.Contains(res.Text, "cut off after") {
		t.Errorf("Text=%q contains the unrelated round-budget label", res.Text)
	}
}

func TestFailureLoopSurvivesInterleavedSuccessAndMixedBatches(t *testing.T) {
	var guard toolFailureLoop
	for i := 0; i < 3; i++ {
		guard.observe([]llm.Block{{Name: "browser_open"}}, []llm.Block{{Text: "opened"}})
		stopped, _ := guard.observe(
			[]llm.Block{{Name: "browser_eval"}, {Name: "read_file"}},
			[]llm.Block{{IsError: true, Text: "SyntaxError: missing )"}, {Text: "ok"}},
		)
		if stopped != (i == 2) {
			t.Fatalf("failure %d: stopped=%v", i+1, stopped)
		}
	}
}

func TestFailureLoopNormalizesBrowserLocations(t *testing.T) {
	var guard toolFailureLoop
	for i, location := range []string{"(0:40)", "(0:62)", "(1:19)"} {
		stopped, _ := guard.observe([]llm.Block{{Name: "browser_eval"}},
			[]llm.Block{{IsError: true, Text: `exception "Uncaught" ` + location + ": SyntaxError: missing )"}})
		if stopped != (i == 2) {
			t.Fatalf("location %s: stopped=%v", location, stopped)
		}
	}
}

func TestFailureLoopAgesOutOldFailures(t *testing.T) {
	var guard toolFailureLoop
	call := []llm.Block{{Name: "browser_eval"}}
	failure := []llm.Block{{IsError: true, Text: "SyntaxError: missing )"}}
	guard.observe(call, failure)
	guard.observe(call, failure)
	for i := 0; i < toolFailureWindow; i++ {
		if stopped, _ := guard.observe(call, []llm.Block{{Text: "true"}}); stopped {
			t.Fatal("successful work stopped")
		}
	}
	if stopped, _ := guard.observe(call, failure); stopped {
		t.Fatal("old failures survived window")
	}
}
