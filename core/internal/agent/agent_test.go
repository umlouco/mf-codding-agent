package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

/*
The round ceiling is the one place the loop can end without the model having
said anything, so it is the one place a worker can hand its supervisor no
evidence. These tests pin the contract the queue depends on: a turn that runs
out still comes back with text, and still admits it was cut off.
*/

// fakeProvider answers with a tool call until it is offered no tools, which is
// exactly the condition finalReport creates.
type fakeProvider struct {
	calls        int
	toolless     int
	finalText    string
	lastToolsLen int
	// delay makes a round take measurable time.
	delay time.Duration
	// wireEvery, when set, reports bytes at that interval for the whole delay.
	// A reply that keeps delivering is slow; one that delivers nothing is dead,
	// and this field is the difference between the two.
	wireEvery time.Duration
}

// wait burns `delay`, reporting wire activity if it was asked to, and gives up
// the moment the context is cancelled — which is what the stall guard does.
func (f *fakeProvider) wait(ctx context.Context, sink func(llm.Event)) error {
	done := time.After(f.delay)
	step := f.wireEvery
	if step <= 0 {
		step = f.delay + time.Hour // never fires: nothing comes off the wire
	}
	tick := time.NewTicker(step)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
			return nil
		case <-tick.C:
			sink(llm.Event{Kind: llm.EventWire, Bytes: 64})
		}
	}
}

func (f *fakeProvider) Name() string  { return "fake" }
func (f *fakeProvider) Model() string { return "fake-1" }

func (f *fakeProvider) Stream(
	ctx context.Context,
	req llm.Request,
	sink func(llm.Event),
) (*llm.Turn, error) {
	f.calls++
	f.lastToolsLen = len(req.Tools)
	if f.delay > 0 {
		if err := f.wait(ctx, sink); err != nil {
			return nil, err
		}
	}

	if len(req.Tools) == 0 {
		f.toolless++
		sink(llm.Event{Kind: llm.EventText, Text: f.finalText})
		return &llm.Turn{
			Blocks:     []llm.Block{{Type: llm.BlockText, Text: f.finalText}},
			StopReason: "end_turn",
			Usage:      llm.Usage{Input: 1, Output: 1},
		}, nil
	}

	return &llm.Turn{
		Blocks: []llm.Block{{
			Type:  llm.BlockToolUse,
			ID:    "call-1",
			Name:  "noop",
			Input: json.RawMessage(`{}`),
		}},
		StopReason: "tool_use",
		Usage:      llm.Usage{Input: 1, Output: 1},
	}, nil
}

// emitLog captures the notifications the agent pushes to the editor, which is
// where the activity journal comes from.
type emitLog struct {
	mu   sync.Mutex
	rows []map[string]any
}

func (e *emitLog) add(method string, payload any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	m, _ := payload.(map[string]any)
	row := map[string]any{"method": method}
	for k, v := range m {
		row[k] = v
	}
	e.rows = append(e.rows, row)
}

// phases returns the activity phases recorded, in order.
func (e *emitLog) phases() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, r := range e.rows {
		if r["method"] == "agent/activity" {
			out = append(out, r["phase"].(string))
		}
	}
	return out
}

func (e *emitLog) hasPhase(p string) bool {
	for _, got := range e.phases() {
		if got == p {
			return true
		}
	}
	return false
}

func newTestAgent(t *testing.T, p llm.Provider, maxIter int) *Agent {
	a, _ := newLoggedAgent(t, p, maxIter)
	return a
}

func newLoggedAgent(t *testing.T, p llm.Provider, maxIter int) (*Agent, *emitLog) {
	t.Helper()

	reg := tools.NewRegistry()
	reg.Add(&tools.Tool{
		Name:        "noop",
		Description: "does nothing",
		Schema:      map[string]any{"type": "object"},
		Run: func(ctx context.Context, env *tools.Env, input json.RawMessage) tools.Result {
			return tools.Ok("ok")
		},
	})

	cfg := &config.Config{WorkspaceRoot: t.TempDir(), MaxIterations: maxIter}
	env := &tools.Env{Root: cfg.WorkspaceRoot}

	log := &emitLog{}
	return New(cfg, p, reg, env, log.add, "system"), log
}

func TestSendAsksForAReportWhenRoundsRunOut(t *testing.T) {
	fake := &fakeProvider{finalText: "Created tests/e2e/foo.spec.js; the assertion is still missing."}
	a := newTestAgent(t, fake, 3)

	res, err := a.Send(context.Background(), SendRequest{SessionID: "s1", Text: "do the thing"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	// Three tool-calling rounds, then one tool-less round for the report.
	if fake.calls != 4 {
		t.Errorf("provider calls = %d, want 4 (3 rounds + 1 report)", fake.calls)
	}
	if fake.toolless != 1 {
		t.Errorf("tool-less calls = %d, want exactly 1", fake.toolless)
	}
	if res.StopReason != "max_iterations" {
		t.Errorf("StopReason = %q, want max_iterations", res.StopReason)
	}
	// The whole point: the caller gets what the model actually said, not a
	// canned string, so a supervisor can tell partial work from no work.
	if !strings.Contains(res.Text, fake.finalText) {
		t.Errorf("Text = %q, want it to contain the model's report", res.Text)
	}
	if !strings.Contains(res.Text, "cut off") {
		t.Errorf("Text = %q, want it marked as a cut-off report", res.Text)
	}
	if res.Iterations != 3 {
		t.Errorf("Iterations = %d, want 3", res.Iterations)
	}
}

/*
The rest of these pin the liveness contract, which exists so that no part of a
turn is ever cut off for being slow.

A local model can take hours over one reply. The only thing that ends a call is
a connection that has stopped delivering, and the only way an observer can tell
those apart is the journal these tests read.
*/

// A reply that keeps delivering bytes must be allowed to take as long as it
// takes, even when each byte arrives well after the idle window would have
// fired had the connection been silent.
func TestASlowReplyIsNeverCutOff(t *testing.T) {
	fake := &fakeProvider{
		finalText: "took my time, got there",
		delay:     1200 * time.Millisecond,
		wireEvery: 200 * time.Millisecond,
	}
	a, log := newLoggedAgent(t, fake, 1)
	a.cfg.LLMIdleSeconds = 1 // shorter than a single reply takes
	a.cfg.ActivitySeconds = 1

	res, err := a.Send(context.Background(), SendRequest{SessionID: "s1", Text: "do the thing"})
	if err != nil {
		t.Fatalf("Send: %v — a slow reply must not be treated as a dead one", err)
	}
	if !strings.Contains(res.Text, fake.finalText) {
		t.Errorf("Text = %q, want the model's answer", res.Text)
	}
	if log.hasPhase(PhaseStalled) {
		t.Error("a reply that kept delivering bytes was recorded as stalled")
	}
	// And it said so while it waited, rather than going quiet for two seconds.
	if !log.hasPhase(PhaseStreaming) {
		t.Errorf("phases = %v, want the wait to have been journalled", log.phases())
	}
}

// A connection that delivers nothing for the whole idle window is dropped, and
// the journal says so — that record is the only evidence the worker leaves.
func TestASilentConnectionIsDroppedAndRecorded(t *testing.T) {
	fake := &fakeProvider{finalText: "never got here", delay: 30 * time.Second}
	a, log := newLoggedAgent(t, fake, 3)
	a.cfg.LLMIdleSeconds = 1
	a.cfg.ActivitySeconds = 1

	start := time.Now()
	_, err := a.Send(context.Background(), SendRequest{SessionID: "s1", Text: "do the thing"})
	if err == nil {
		t.Fatal("Send returned no error for a connection that delivered nothing")
	}
	if took := time.Since(start); took > 25*time.Second {
		t.Errorf("took %s — the stall guard did not fire", took)
	}
	if !strings.Contains(err.Error(), "dropped") {
		t.Errorf("error = %q, want it to say the connection was dropped", err)
	}
	if !log.hasPhase(PhaseStalled) {
		t.Errorf("phases = %v, want a stalled record in the journal", log.phases())
	}
	if !log.hasPhase(PhaseError) {
		t.Errorf("phases = %v, want the failure recorded as well", log.phases())
	}
}

// Rounds are the only budget a turn has. Nothing about how long it took may
// change where it stops.
func TestRoundsAreTheOnlyBudget(t *testing.T) {
	fake := &fakeProvider{
		finalText: "done what I could",
		delay:     300 * time.Millisecond,
		wireEvery: 50 * time.Millisecond,
	}
	a, log := newLoggedAgent(t, fake, 3)
	a.cfg.ActivitySeconds = 1

	res, err := a.Send(context.Background(), SendRequest{SessionID: "s1", Text: "do the thing"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if res.StopReason != "max_iterations" {
		t.Errorf("StopReason = %q, want max_iterations", res.StopReason)
	}
	if res.Iterations != 3 {
		t.Errorf("Iterations = %d, want 3", res.Iterations)
	}
	// Every round the model was asked for is a journal entry, so an observer
	// can tell how far along a turn is without waiting for it to finish.
	if !log.hasPhase(PhaseModel) {
		t.Errorf("phases = %v, want each round recorded", log.phases())
	}
	if !log.hasPhase(PhaseTool) {
		t.Errorf("phases = %v, want tool runs recorded", log.phases())
	}
	if !log.hasPhase(PhaseReport) {
		t.Errorf("phases = %v, want the closing report recorded", log.phases())
	}
}

// The nudge that forces the report must not survive into the session: the next
// turn gets a fresh budget, and a history saying "you have no tools left" would
// teach the model otherwise.
func TestCutOffNudgeIsNotKeptInTheSession(t *testing.T) {
	fake := &fakeProvider{finalText: "partial progress"}
	a := newTestAgent(t, fake, 2)

	if _, err := a.Send(context.Background(), SendRequest{SessionID: "s1", Text: "go"}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	sess := a.Session("s1")
	for i, m := range sess.Messages {
		for _, b := range m.Blocks {
			if strings.Contains(b.Text, "no more tools are available") {
				t.Fatalf("message %d still carries the cut-off nudge: %q", i, b.Text)
			}
		}
	}

	last := sess.Messages[len(sess.Messages)-1]
	if last.Role != llm.RoleAssistant {
		t.Errorf("last message role = %q, want assistant's report", last.Role)
	}
}

// A turn that finishes normally must not pay for an extra call.
func TestSendStopsAtFirstTextAnswer(t *testing.T) {
	fake := &fakeProvider{finalText: "done"}
	a := newTestAgent(t, fake, 5)
	// No tools registered means the very first call is tool-less and answers.
	a.registry = tools.NewRegistry()

	res, err := a.Send(context.Background(), SendRequest{SessionID: "s1", Text: "hi"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if fake.calls != 1 {
		t.Errorf("provider calls = %d, want 1", fake.calls)
	}
	if res.StopReason == "max_iterations" {
		t.Error("StopReason should not be max_iterations for a normal answer")
	}
	if res.Text != "done" {
		t.Errorf("Text = %q, want %q", res.Text, "done")
	}
}
