package agent

import (
	"context"
	"encoding/json"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
	"strings"
	"testing"
)

func TestGuidanceArrivesAfterToolResultsWithoutRestart(t *testing.T) {
	p := &cognitionProvider{rounds: [][]llm.Block{{cognitionCall("probe-1", "probe")}}}
	a := newTestAgent(t, p, 3)
	if a.Steer("work", "too early") {
		t.Fatal("accepted absent worker")
	}
	a.registry.Add(&tools.Tool{Name: "probe", Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
		if !a.Steer("work", "Inspect the current route before changing code.") {
			t.Fatal("active worker rejected advice")
		}
		if a.Steer("other", "wrong task") {
			t.Fatal("accepted wrong worker")
		}
		return tools.Ok("observed runtime response")
	}})
	if _, err := a.Send(context.Background(), SendRequest{SessionID: "work", Text: "Test the supplied program."}); err != nil {
		t.Fatal(err)
	}
	if len(p.requests) != 2 {
		t.Fatalf("requests=%d", len(p.requests))
	}
	msgs := p.requests[1].Messages
	if len(msgs) != 4 {
		t.Fatalf("messages=%d", len(msgs))
	}
	if msgs[1].Blocks[0].Type != llm.BlockToolUse || msgs[2].Blocks[0].Type != llm.BlockToolResult {
		t.Fatal("guidance split tool protocol pair")
	}
	if !strings.Contains(messageText(msgs[3:]), "Inspect the current route") {
		t.Fatal("next round missed guidance")
	}
	if strings.Contains(messageText(p.requests[0].Messages), "Inspect the current route") {
		t.Fatal("mutated in-flight request")
	}
	if a.Steer("work", "too late") {
		t.Fatal("accepted finished worker")
	}
	if _, err := a.Send(context.Background(), SendRequest{SessionID: "next", Text: "Separate task"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(messageText(p.requests[2].Messages), "Inspect the current route") {
		t.Fatal("guidance leaked to another task")
	}
}
