package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

// Ceiling on tool-calling rounds in one turn, when the config does not set one.
//
// An interactive chat turn and an unattended queue worker want very different
// budgets: a person watching the chat can just say "continue", while a worker
// that runs out has nobody to ask. The core takes the number from config so the
// editor can raise it per role, and per retry.
const defaultMaxIterations = 40

// Emitter pushes streaming updates back to the editor.
type Emitter func(method string, payload any)

type Agent struct {
	cfg      *config.Config
	provider llm.Provider
	registry *tools.Registry
	env      *tools.Env
	emit     Emitter

	mu       sync.Mutex
	sessions map[string]*Session
	system   string
}

type Session struct {
	ID       string
	Messages []llm.Message
	Usage    llm.Usage
	Started  time.Time
}

func New(cfg *config.Config, p llm.Provider, r *tools.Registry, env *tools.Env, emit Emitter, system string) *Agent {
	return &Agent{
		cfg: cfg, provider: p, registry: r, env: env, emit: emit,
		sessions: map[string]*Session{}, system: system,
	}
}

func (a *Agent) SetSystem(s string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.system = s
}

func (a *Agent) Session(id string) *Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[id]
	if !ok {
		s = &Session{ID: id, Started: time.Now()}
		a.sessions[id] = s
	}
	return s
}

func (a *Agent) Reset(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.sessions, id)
}

type SendRequest struct {
	SessionID     string   `json:"sessionId"`
	Text          string   `json:"text"`
	OpenFiles     []string `json:"openFiles"`
	Selection     string   `json:"selection"`
	SelectionPath string   `json:"selectionPath"`
}

type SendResult struct {
	SessionID  string    `json:"sessionId"`
	Text       string    `json:"text"`
	StopReason string    `json:"stopReason"`
	Usage      llm.Usage `json:"usage"`
	Iterations int       `json:"iterations"`
}

func (a *Agent) Send(ctx context.Context, req SendRequest) (*SendResult, error) {
	sess := a.Session(req.SessionID)

	user := req.Text
	if pre := turnPreamble(req.OpenFiles, req.Selection, req.SelectionPath); pre != "" {
		user = pre + "\n\n" + req.Text
	}

	a.mu.Lock()
	sess.Messages = append(sess.Messages, llm.UserText(user))
	system := a.system
	a.mu.Unlock()

	defs := a.toolDefs()
	result := &SendResult{SessionID: req.SessionID}
	maxIterations := a.maxIterations()

	// Accumulate text across every assistant turn, not just the final one.
	// OpenAI-compatible models routinely emit text and a tool call in the
	// same response chunk, and the text is added to the session but not to
	// the result. A planner that writes its JSON array then calls read_file
	// in the same turn would produce a final result with no JSON at all.
	var accumulated strings.Builder
	var failures toolFailureLoop

	for iter := 1; iter <= maxIterations; iter++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		result.Iterations = iter
		a.activity(req.SessionID, PhaseModel, fmt.Sprintf(
			"round %d of %d — sending %d messages to %s",
			iter, maxIterations, len(sess.Messages), a.provider.Model()))

		a.mu.Lock()
		msgs := make([]llm.Message, len(sess.Messages))
		copy(msgs, sess.Messages)
		a.mu.Unlock()

		turn, err := a.stream(ctx, req.SessionID, llm.Request{
			System: system, Messages: msgs, Tools: defs,
		}, func(ev llm.Event) {
			switch ev.Kind {
			case llm.EventText:
				a.emit("stream/text", map[string]any{"sessionId": req.SessionID, "delta": ev.Text})
			case llm.EventThinking:
				a.emit("stream/thinking", map[string]any{"sessionId": req.SessionID, "delta": ev.Text})
			case llm.EventToolStart:
				a.emit("stream/tool", map[string]any{
					"sessionId": req.SessionID, "id": ev.ToolID,
					"name": ev.ToolName, "status": "start",
				})
			}
		})
		if err != nil {
			return nil, err
		}

		turnText := turn.Text()
		if turnText != "" {
			if accumulated.Len() > 0 {
				accumulated.WriteString("\n\n")
			}
			accumulated.WriteString(turnText)
		}

		a.mu.Lock()
		sess.Messages = append(sess.Messages, llm.Message{Role: llm.RoleAssistant, Blocks: turn.Blocks})
		sess.Usage.Input += turn.Usage.Input
		sess.Usage.Output += turn.Usage.Output
		sess.Usage.CacheRead += turn.Usage.CacheRead
		sess.Usage.CacheWrite += turn.Usage.CacheWrite
		result.Usage = sess.Usage
		a.mu.Unlock()

		calls := turn.ToolCalls()
		if len(calls) == 0 {
			result.Text = accumulated.String()
			result.StopReason = turn.StopReason
			a.activity(req.SessionID, PhaseDone, fmt.Sprintf(
				"answered after %d round(s), %d in / %d out tokens",
				iter, result.Usage.Input, result.Usage.Output))
			a.emit("stream/done", map[string]any{
				"sessionId": req.SessionID, "stopReason": turn.StopReason,
				"usage": result.Usage, "iterations": iter,
			})
			return result, nil
		}

		results := a.runTools(ctx, req.SessionID, calls)

		// Every tool_use must get exactly one tool_result, and they all go
		// back in a single user turn — splitting them trains the model out of
		// parallel tool use.
		a.mu.Lock()
		sess.Messages = append(sess.Messages, llm.Message{Role: llm.RoleUser, Blocks: results})
		a.mu.Unlock()

		if repeated, detail := failures.observe(calls, results); repeated {
			a.activity(req.SessionID, PhaseError, detail+"; stopping the tool loop")
			return a.repeatedFailureReport(
				ctx, req, sess, system, iter, accumulated.String(), detail)
		}
	}

	// The round budget is spent. Do not throw away what the agent learned: spend
	// one more call with no tools attached, so the model cannot ask for another
	// round and has to say what it actually did.
	//
	// This matters most where nobody is watching. A queue worker that returns a
	// canned "stopped after N rounds" gives its supervisor no evidence either
	// way, and "nothing reported" is indistinguishable from "nothing done" — so
	// the supervisor retries a task that may already be half-built, and the next
	// attempt starts from zero with the same budget.
	return a.finalReport(ctx, req, sess, system, maxIterations, accumulated.String())
}

func (a *Agent) maxIterations() int {
	if n := a.cfg.MaxIterations; n > 0 {
		return n
	}
	return defaultMaxIterations
}

/*
finalReport asks for a plain account of the turn after the rounds ran out.

The nudge is deliberately not kept in the session. It is true only for the turn
that ran out, and a later turn starts with a fresh budget — leaving "you have no
tool calls left" in the history teaches the model it is out of tools when it is
not. The reply is kept: it is a real assistant message about real work.
*/
func (a *Agent) finalReport(
	ctx context.Context,
	req SendRequest,
	sess *Session,
	system string,
	rounds int,
	accumulated string,
) (*SendResult, error) {
	result := &SendResult{SessionID: req.SessionID, Iterations: rounds, StopReason: "max_iterations"}
	a.activity(req.SessionID, PhaseReport, fmt.Sprintf(
		"round budget spent after %d rounds — asking for a handoff report", rounds))

	nudge := fmt.Sprintf(
		"You have used all %d tool-calling rounds for this turn, so no more tools are "+
			"available to you. Do not plan further work and do not ask to continue.\n\n"+
			"Report now, plainly:\n"+
			"- what you changed, naming every file you actually created or edited\n"+
			"- what you verified, and how you verified it\n"+
			"- what is still missing, precisely enough for the next agent to finish it "+
			"without repeating your work",
		rounds)

	a.mu.Lock()
	msgs := make([]llm.Message, len(sess.Messages), len(sess.Messages)+1)
	copy(msgs, sess.Messages)
	msgs = append(msgs, llm.UserText(nudge))
	a.mu.Unlock()

	// No Tools on this request: that is what forces text instead of another call.
	turn, err := a.stream(ctx, req.SessionID, llm.Request{System: system, Messages: msgs},
		func(ev llm.Event) {
			switch ev.Kind {
			case llm.EventText:
				a.emit("stream/text", map[string]any{"sessionId": req.SessionID, "delta": ev.Text})
			case llm.EventThinking:
				a.emit("stream/thinking", map[string]any{"sessionId": req.SessionID, "delta": ev.Text})
			}
		})
	if err != nil {
		// Even the summary failed. Say what is known rather than nothing at all.
		a.mu.Lock()
		result.Usage = sess.Usage
		a.mu.Unlock()
		var prefix string
		if accumulated != "" {
			prefix = accumulated + "\n\n"
		}
		result.Text = fmt.Sprintf(
			"%sStopped after %d tool-calling rounds, and the closing summary could not be "+
				"produced: %v. Treat any work from this turn as unverified.", prefix, rounds, err)
		a.emit("stream/done", map[string]any{
			"sessionId": req.SessionID, "stopReason": "max_iterations",
			"usage": result.Usage, "iterations": rounds,
		})
		return result, nil
	}

	a.mu.Lock()
	sess.Messages = append(sess.Messages, llm.Message{Role: llm.RoleAssistant, Blocks: turn.Blocks})
	sess.Usage.Input += turn.Usage.Input
	sess.Usage.Output += turn.Usage.Output
	sess.Usage.CacheRead += turn.Usage.CacheRead
	sess.Usage.CacheWrite += turn.Usage.CacheWrite
	result.Usage = sess.Usage
	a.mu.Unlock()

	var prefix string
	if accumulated != "" {
		prefix = accumulated + "\n\n"
	}
	result.Text = fmt.Sprintf(
		"%s[cut off after %d tool-calling rounds — this is a partial-progress report, not a "+
			"finished task]\n\n%s", prefix, rounds, turn.Text())
	a.emit("stream/done", map[string]any{
		"sessionId": req.SessionID, "stopReason": "max_iterations",
		"usage": result.Usage, "iterations": rounds,
	})
	return result, nil
}

func (a *Agent) toolDefs() []llm.ToolDef {
	if a.cfg.DisableTools {
		return nil
	}
	list := a.registry.List()
	defs := make([]llm.ToolDef, 0, len(list))
	for _, t := range list {
		defs = append(defs, llm.ToolDef{Name: t.Name, Description: t.Description, Schema: t.Schema})
	}
	return defs
}

// runTools executes a batch of tool calls. Read-only tools run concurrently;
// anything that mutates state runs serially in the order the model asked for,
// because ordering matters for edits and shell commands.
func (a *Agent) runTools(ctx context.Context, sessionID string, calls []llm.Block) []llm.Block {
	out := make([]llm.Block, len(calls))

	var wg sync.WaitGroup
	var serial []int

	for i, c := range calls {
		t, ok := a.registry.Get(c.Name)
		if !ok {
			out[i] = llm.Block{
				Type: llm.BlockToolResult, ToolUseID: c.ID, IsError: true,
				Text: fmt.Sprintf("Unknown tool %q. Available: %s", c.Name, a.toolNames()),
			}
			continue
		}
		if t.Mutates(c.Input) {
			serial = append(serial, i)
			continue
		}
		wg.Add(1)
		go func(idx int, call llm.Block, tool *tools.Tool) {
			defer wg.Done()
			out[idx] = a.invoke(ctx, sessionID, call, tool)
		}(i, c, t)
	}
	wg.Wait()

	for _, i := range serial {
		t, _ := a.registry.Get(calls[i].Name)
		out[i] = a.invoke(ctx, sessionID, calls[i], t)
	}
	return out
}

func (a *Agent) invoke(ctx context.Context, sessionID string, call llm.Block, t *tools.Tool) llm.Block {
	summary := t.Describe(call.Input)
	a.emit("stream/tool", map[string]any{
		"sessionId": sessionID, "id": call.ID, "name": call.Name,
		"status": "running", "input": json.RawMessage(call.Input),
		// Nothing pauses for approval, so this line is the only warning the
		// user gets that a write or a command is happening. It goes out before
		// Run, not after, so it is on screen while the work is in flight.
		"summary": summary,
	})
	a.activity(sessionID, PhaseTool, fmt.Sprintf("%s: %s", call.Name, summary))

	start := time.Now()
	stopBeat := a.beat(sessionID, PhaseTool, func(d time.Duration) string {
		return fmt.Sprintf("%s still running after %s", call.Name, brief(d))
	})
	defer stopBeat()

	// A panicking tool must not take the whole turn down with it: the model
	// can recover from an error result, and cannot recover from a dead core.
	res := func() (r tools.Result) {
		defer func() {
			if p := recover(); p != nil {
				r = tools.Errf("tool %s panicked: %v", call.Name, p)
			}
		}()
		return t.Run(ctx, a.env, call.Input)
	}()

	status := "ok"
	if res.IsError {
		status = "error"
	}
	a.emit("stream/tool", map[string]any{
		"sessionId": sessionID, "id": call.ID, "name": call.Name,
		"status": status, "output": truncateForUI(res.Output),
		"meta": res.Meta, "elapsedMs": time.Since(start).Milliseconds(),
	})
	// Journalled after the fact rather than before: a tool that took twenty
	// minutes is worth recording as twenty minutes of real work, which is what
	// keeps a long build from looking like a stall to whoever is watching.
	a.activity(sessionID, PhaseTool, fmt.Sprintf(
		"%s finished %s in %s", call.Name, status, brief(time.Since(start))))

	return llm.Block{
		Type: llm.BlockToolResult, ToolUseID: call.ID,
		Text: res.Output, IsError: res.IsError,
	}
}

func truncateForUI(s string) string {
	const n = 4000
	if len(s) <= n {
		return s
	}
	return s[:n] + fmt.Sprintf("\n… (%d more bytes)", len(s)-n)
}

func (a *Agent) toolNames() string {
	list := a.registry.List()
	names := make([]string, 0, len(list))
	for _, t := range list {
		names = append(names, t.Name)
	}
	return strings.Join(names, ", ")
}
