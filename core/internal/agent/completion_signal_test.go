package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

func TestWrongTestingTargetHandsOffWithoutAnotherModelRequest(t *testing.T) {
	provider := &cognitionProvider{rounds: [][]llm.Block{{{Type: llm.BlockToolUse, ID: "wrong-target", Name: "browser_open", Input: json.RawMessage(`{"url":"http://localhost:8000/"}`)}}}}
	a := newTestAgent(t, provider, 24)
	a.env.Testing.URL = "https://app.example.test/project/"
	a.registry.Add(&tools.Tool{Name: "browser_open", Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
		t.Fatal("blocked target reached browser")
		return tools.Ok("unreachable")
	}})
	result, err := a.Send(context.Background(), SendRequest{SessionID: "target", Text: "Test the configured application"})
	if err != nil || result.StopReason != "testing_target_blocked" || len(provider.requests) != 1 {
		t.Fatalf("result=%+v err=%v requests=%d", result, err, len(provider.requests))
	}
}

func TestEditorCompletionHandsOffWithoutReenteringToolLoop(t *testing.T) {
	provider := &cognitionProvider{rounds: [][]llm.Block{{cognitionCall("complete", "editor__task_complete")}}}
	a := newTestAgent(t, provider, 24)
	a.SetCognition(&cognitionJournal{})
	called := 0
	a.registry.Add(&tools.Tool{Name: "editor__task_complete", Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
		called++
		return tools.Ok("Work is ready for review")
	}})
	result, err := a.Send(context.Background(), SendRequest{SessionID: "handoff", Text: "Finish the task and report"})
	if err != nil || result.StopReason != "completion_signal" || result.Iterations != 1 || called != 1 {
		t.Fatalf("result=%+v error=%v completion calls=%d", result, err, called)
	}
	if len(provider.requests) != 2 || len(provider.requests[1].Tools) != 0 || strings.Contains(result.Text, "partial-progress") {
		t.Fatalf("expected one final report, without resumed tool use: %+v", result)
	}
}

func TestFailedCompletionToolDoesNotEndRecovery(t *testing.T) {
	provider := &cognitionProvider{rounds: [][]llm.Block{{cognitionCall("complete", "editor__task_complete")}}}
	a := newTestAgent(t, provider, 24)
	a.registry.Add(&tools.Tool{Name: "editor__task_complete", Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
		return tools.Errf("Could not record completion")
	}})
	result, err := a.Send(context.Background(), SendRequest{SessionID: "handoff", Text: "Finish the task and report"})
	if err != nil || result.StopReason != "end_turn" || len(provider.requests[1].Tools) == 0 {
		t.Fatalf("failed completion removed recovery tools: result=%+v error=%v", result, err)
	}
}
