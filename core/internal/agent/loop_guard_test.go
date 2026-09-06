package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

func TestUnchangedObservationWarnsBeforeRecoveryAndResetsOnProgress(t *testing.T) {
	var guard unchangedToolLoop
	call := []llm.Block{{Name: "browser_open", Input: json.RawMessage(`{"url":"https://example.test/"}`)}}
	result := []llm.Block{{Text: "Sign in"}}
	for i := 1; i <= 5; i++ {
		warn, stop, _ := guard.observe(call, result)
		if warn != (i == 3) || stop != (i == 5) {
			t.Fatalf("round %d: warn=%v stop=%v", i, warn, stop)
		}
	}
	if warn, stop, _ := guard.observe(call, []llm.Block{{Text: "Dashboard"}}); warn || stop {
		t.Fatal("changed page treated as a loop")
	}
	for _, name := range []string{"browser_fill", "browser_click", "shell_wait_for_http", "browser_wait", "run_shell"} {
		for i := 0; i < 8; i++ {
			if warn, stop, _ := guard.observe([]llm.Block{{Name: name, Input: json.RawMessage(`{}`)}}, result); warn || stop {
				t.Fatalf("action/wait %s treated as observation loop", name)
			}
		}
	}
	if warn, stop, _ := guard.observe(call, result); warn || stop {
		t.Fatal("intervening action did not reset observation loop")
	}
}

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

func TestUnchangedSuccessHandsOffWithoutClaimingCompletion(t *testing.T) {
	fake := &fakeProvider{toolName: "read_file", finalText: `{"status":"NEEDS_MORE_WORK","summary":"Repeated observation; inspect the missing action."}`}
	a := newTestAgent(t, fake, 80)
	a.registry = tools.NewRegistry()
	a.registry.Add(&tools.Tool{Name: "read_file", Schema: map[string]any{"type": "object"}, Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result { return tools.Ok("unchanged source") }})
	result, err := a.Send(context.Background(), SendRequest{SessionID: "repeat-success", Text: "Read the source and implement the requested change"})
	if err != nil {
		t.Fatal(err)
	}
	if result.StopReason != "unchanged_tool_loop" || result.Iterations != 5 || !strings.Contains(result.Text, "NEEDS_MORE_WORK") {
		t.Fatalf("invalid recovery: %+v", result)
	}
}

func TestRepeatedToolFailureStopsEarly(t *testing.T) {
	for _, withMemory := range []bool{false, true} {
		t.Run(fmt.Sprint("memory=", withMemory), func(t *testing.T) {
			fake := &fakeProvider{finalText: "Stopped after a repeated tool failure."}
			a := newTestAgent(t, fake, 80)
			if withMemory {
				a.SetCognition(&cognitionJournal{})
			}
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
		})
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

func TestFailureLoopDistinguishesErrorsUnderTheSameTestFooter(t *testing.T) {
	var guard toolFailureLoop
	call := []llm.Block{{Name: "run_shell", Input: json.RawMessage(`{}`)}}
	footer := "\n1 failed\nworkflow.spec.js:3:1 > full application flow"
	for _, diagnostic := range []string{"TypeError: url.includes is not a function", "TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.\nCall log:\n - waiting for locator('.form') to be visible", "TimeoutError: page.waitForSelector: Timeout 5000ms exceeded.\nCall log:\n - waiting for locator('.different-control') to be visible"} {
		if stop, detail := guard.observe(call, []llm.Block{{IsError: true, Text: diagnostic + footer}}); stop {
			t.Fatalf("different failures collapsed into one: %s", detail)
		}
	}
	var repeat toolFailureLoop
	for i := 0; i < 3; i++ {
		output := fmt.Sprintf("exit=1 elapsed=%ds\nTimeoutError: page.waitForSelector: Timeout 5000ms exceeded.\nCall log:\n - waiting for locator('.form') to be visible\n at spec.js:%d:3%s", i+1, i+10, footer)
		stop, _ := repeat.observe(call, []llm.Block{{IsError: true, Text: output}})
		if stop != (i == 2) {
			t.Fatalf("same failure at changing presentation locations: stop=%v iteration=%d", stop, i)
		}
	}
}
