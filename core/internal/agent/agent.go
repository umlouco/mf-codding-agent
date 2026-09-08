package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mflores/mfagent/core/internal/cognition"
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

// Context tokens one round may carry, when the config does not set a ceiling.
//
// Deliberately far above any honest turn: this is not a work budget, it is the
// last thing standing between an uncapped tool loop and the provider rejecting
// the request outright. See config.MaxContextTokens.
const defaultMaxContextTokens = 200_000

// halt says why a tool loop stopped before the model answered on its own.
//
// The zero value means the round budget simply ran out. Anything else is a
// condition the loop detected and chose to stop on, and both fields matter:
// `reason` is what the editor switches on, `detail` is what the model and the
// operator are told.
type halt struct {
	reason string
	detail string
}

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
	journal  cognition.Journal
}

type Session struct {
	ID       string
	Messages []llm.Message
	Usage    llm.Usage
	Started  time.Time
	running  bool
	guidance string
}

func New(cfg *config.Config, p llm.Provider, r *tools.Registry, env *tools.Env, emit Emitter, system string) *Agent {
	env.QueueRole = cfg.QueueRole
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
	SessionID     string           `json:"sessionId"`
	Text          string           `json:"text"`
	OpenFiles     []string         `json:"openFiles"`
	Selection     string           `json:"selection"`
	SelectionPath string           `json:"selectionPath"`
	Cognition     *cognition.Scope `json:"cognition,omitempty"`
}

type SendResult struct {
	SessionID  string    `json:"sessionId"`
	Text       string    `json:"text"`
	StopReason string    `json:"stopReason"`
	Usage      llm.Usage `json:"usage"`
	Iterations int       `json:"iterations"`
}

func (a *Agent) Send(ctx context.Context, req SendRequest) (*SendResult, error) {
	req.Text = a.env.TestingPrompt(req.Text)
	ctx = a.startCognition(ctx, req)
	sess := a.Session(req.SessionID)
	a.mu.Lock()
	if sess.running {
		a.mu.Unlock()
		return nil, fmt.Errorf("session already has an active turn")
	}
	sess.running = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); sess.running = false; sess.guidance = ""; a.mu.Unlock() }()

	user := req.Text
	if pre := turnPreamble(req.OpenFiles, req.Selection, req.SelectionPath); pre != "" {
		user = pre + "\n\n" + req.Text
	}

	a.mu.Lock()
	sess.Messages = append(sess.Messages, llm.UserText(user))
	system := a.system
	if a.cfg.InspectOnly {
		system = "This turn is a live inspection-only review. Read evidence and return the requested decision. The supervisor owns test rewrites: request STOP_AND_REWRITE_TESTS to stop the executor and enter a dedicated supervisor repair turn with editing tools. Mutating tools and arbitrary commands are unavailable during this live inspection.\n\n" + system
	}
	if a.cfg.ResponseOnly {
		system = "You review supplied text and evidence. Follow the current request and its response schema exactly. You cannot inspect files or execute tools in this turn. Do not propose tool calls, XML checks, or an investigation. Owner requirements outrank derived task instructions and prior agent conclusions. Preserve required behavior and assertions. Return the requested decision using only the supplied information; distinguish missing evidence from a proven defect."
		if a.cfg.QueueRole == "supervisor" || a.cfg.QueueRole == "supervisor-repair" {
			system = supervisorResponsePolicy
		}
		if a.cfg.QueueRole == "validator" {
			system = validatorPolicy + "\nTools are unavailable in this response turn. Use only the supplied requirements and host evidence."
		}
	}
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
	var unchanged unchangedToolLoop

	for iter := 1; maxIterations == 0 || iter <= maxIterations; iter++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		result.Iterations = iter
		if maxIterations == 0 {
			a.activity(req.SessionID, PhaseModel, fmt.Sprintf(
				"round %d — sending %d messages to %s",
				iter, len(sess.Messages), a.provider.Model()))
		} else {
			a.activity(req.SessionID, PhaseModel, fmt.Sprintf(
				"round %d of %d — sending %d messages to %s",
				iter, maxIterations, len(sess.Messages), a.provider.Model()))
		}

		a.mu.Lock()
		if sess.guidance != "" {
			sess.Messages = append(sess.Messages, llm.UserText("SUPERVISOR GUIDANCE FOR THE CURRENT TASK:\n"+sess.guidance+"\nTreat this as derived advice, not new owner requirements or proof. Confirm hypotheses against current evidence. Preserve the task's acceptance criteria."))
			sess.guidance = ""
		}
		msgs := make([]llm.Message, len(sess.Messages))
		copy(msgs, sess.Messages)
		a.mu.Unlock()
		if !a.cfg.ResponseOnly {
			msgs = a.cognitionMessages(ctx, req.SessionID, msgs)
		}

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
		if a.cfg.ResponseOnly && len(calls) > 0 {
			return nil, fmt.Errorf("the response-only reviewer requested tools instead of returning the requested decision")
		}
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

		// A fixed-target rejection is an invalid premise, not a transient tool
		// error to retry for another model round. Hand the evidence back now.
		for _, toolResult := range results {
			if toolResult.IsError && strings.HasPrefix(toolResult.Text, "queue ownership:") {
				result.Text = "Execution stopped: " + toolResult.Text
				result.StopReason = "supervisor_repair_required"
				return result, nil
			}
			if toolResult.IsError && strings.HasPrefix(toolResult.Text, "testing environment:") {
				result.Text = "Execution stopped: " + toolResult.Text + ". Supervisor must correct the testing target before resuming."
				result.StopReason = "testing_target_blocked"
				return result, nil
			}
		}

		// VS Code's completion tool expresses an intent to hand work back. It
		// does not verify the work, but ignoring it can leave the model calling
		// task_complete and rereading the same files until the round ceiling.
		for i, call := range calls {
			if call.Name == "editor__task_complete" && i < len(results) && !results[i].IsError {
				return a.finalReport(ctx, req, sess, system, iter, accumulated.String(),
					halt{reason: "completion_signal", detail: "you signalled task completion; return the required handoff report for independent review"})
			}
		}

		// Operational memory records the failure; it must not disable the
		// handoff that lets a fresh worker/supervisor choose another approach.
		if repeated, detail := failures.observe(calls, results); repeated {
			a.activity(req.SessionID, PhaseError, detail+"; stopping the tool loop")
			return a.finalReport(ctx, req, sess, system, iter, accumulated.String(),
				halt{reason: "repeated_tool_error", detail: detail})
		}
		if warn, stop, detail := unchanged.observe(calls, results); stop {
			a.activity(req.SessionID, PhaseError, detail+"; handing off for recovery")
			return a.finalReport(ctx, req, sess, system, iter, accumulated.String(),
				halt{reason: "unchanged_tool_loop", detail: detail})
		} else if warn {
			a.activity(req.SessionID, PhaseError, detail)
			a.mu.Lock()
			sess.Messages = append(sess.Messages, llm.UserText("Runtime observation: "+detail+". This does not establish a task defect or completion."))
			a.mu.Unlock()
		}

		// Cache reads and writes are context too — a provider that caches the
		// prefix reports a small Input for a conversation that is anything but,
		// so counting Input alone would leave a cached run with no backstop at
		// all. A provider that reports no usage fails open, as it does
		// everywhere else usage is read.
		if limit := a.maxContextTokens(); limit > 0 {
			carried := turn.Usage.ContextTokens()
			if carried >= limit {
				detail := fmt.Sprintf(
					"the conversation reached %d context tokens, this run's ceiling, "+
						"without the model finishing", carried)
				a.activity(req.SessionID, PhaseError, detail+"; stopping the tool loop")
				return a.finalReport(ctx, req, sess, system, iter, accumulated.String(),
					halt{reason: "context_limit", detail: detail})
			}
		}
	}

	// The round budget is spent (an unbounded turn never reaches this line — it
	// leaves through one of the returns above). Do not throw away what the agent learned: spend
	// one more call requesting a report of what the model actually did. The tool
	// loop has ended; omitting tool definitions alone does not prevent tool calls.
	//
	// This matters most where nobody is watching. A queue worker that returns a
	// canned "stopped after N rounds" gives its supervisor no evidence either
	// way, and "nothing reported" is indistinguishable from "nothing done" — so
	// the supervisor retries a task that may already be half-built, and the next
	// attempt starts from zero with the same budget.
	return a.finalReport(ctx, req, sess, system, maxIterations, accumulated.String(), halt{})
}

func (a *Agent) maxIterations() int {
	if a.cfg.MaxIterations < 0 {
		return 0
	}
	if n := a.cfg.MaxIterations; n > 0 {
		return n
	}
	return defaultMaxIterations
}

// maxContextTokens is the round ceiling on carried context, 0 meaning none.
func (a *Agent) maxContextTokens() int64 {
	if a.cfg.MaxContextTokens < 0 {
		return 0
	}
	if n := a.cfg.MaxContextTokens; n > 0 {
		return n
	}
	return defaultMaxContextTokens
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
	h halt,
) (*SendResult, error) {
	stopReason := "max_iterations"
	stopLabel := fmt.Sprintf("cut off after %d tool-calling rounds", rounds)
	stopExplanation := fmt.Sprintf("the %d-round tool-calling budget was exhausted", rounds)
	if h.reason != "" {
		stopReason = h.reason
		stopLabel = fmt.Sprintf("stopped after %d rounds: %s", rounds, h.detail)
		stopExplanation = h.detail
	}
	result := &SendResult{SessionID: req.SessionID, Iterations: rounds, StopReason: stopReason}
	a.activity(req.SessionID, PhaseReport, stopLabel+"; asking for a handoff report")

	nudge := fmt.Sprintf(
		"Tool use has stopped because %s. No more tools are available in this turn. "+
			"Do not claim that a command succeeded unless its successful output is already "+
			"present in the conversation. Do not plan further work and do not ask to continue.\n\n"+
			"Keep the final response format required by the task, including JSON when requested. "+
			"For an execution completion report use NEEDS_MORE_WORK if work remains; for verification "+
			"use INCOMPLETE if required checks could not finish. Include:\n"+
			"- what you changed, naming every file you actually created or edited\n"+
			"- what you verified, and how you verified it\n"+
			"- what is still missing, precisely enough for the next agent to finish it "+
			"without repeating your work",
		stopExplanation)

	a.mu.Lock()
	msgs := make([]llm.Message, len(sess.Messages), len(sess.Messages)+1)
	copy(msgs, sess.Messages)
	msgs = append(msgs, llm.UserText(nudge))
	a.mu.Unlock()
	msgs = a.cognitionMessages(ctx, req.SessionID, msgs)

	// Omit definitions for this final reporting request. This asks for text;
	// it does not guarantee the provider will comply. The tool loop has ended.
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
			"%s[%s]\n\nThe closing summary could not be produced: %v. "+
				"Treat any work from this turn as unverified.", prefix, stopLabel, err)
		a.emit("stream/done", map[string]any{
			"sessionId": req.SessionID, "stopReason": result.StopReason,
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
		"%s[%s; this is a partial-progress report, not a finished task]\n\n%s",
		prefix, stopLabel, turn.Text())
	if stopReason == "completion_signal" {
		// A completion claim is a normal handoff, not a forced partial report.
		// The queue still independently verifies every claim of completion.
		result.Text = prefix + turn.Text()
	}
	a.emit("stream/done", map[string]any{
		"sessionId": req.SessionID, "stopReason": result.StopReason,
		"usage": result.Usage, "iterations": rounds,
	})
	return result, nil
}

func (a *Agent) toolDefs() []llm.ToolDef {
	// Visibility controls context size. runTools still resolves every call
	// against the complete registry, whether its definition was sent or not.
	if a.cfg.DisableTools || a.cfg.ResponseOnly {
		return nil
	}
	list := a.registry.List()
	defs := make([]llm.ToolDef, 0, len(list))
	for _, t := range list {
		if !a.toolAllowed(t) {
			continue
		}
		defs = append(defs, llm.ToolDef{Name: t.Name, Description: t.Description, Schema: t.Schema})
	}
	return defs
}

// runTools preserves the model's mutation barriers. Consecutive read-only calls
// run concurrently; a mutation waits for earlier reads and finishes before later
// reads begin. This matters for a write followed by the read that verifies it.
func (a *Agent) runTools(ctx context.Context, sessionID string, calls []llm.Block) []llm.Block {
	out := make([]llm.Block, len(calls))
	var wg sync.WaitGroup

	for i, c := range calls {
		t, ok := a.registry.Get(c.Name)
		if !ok {
			// An unknown call still has an observed result. Record it after
			// preceding reads, rather than inventing an earlier causal order.
			wg.Wait()
			ticket := a.beginCognition(ctx, sessionID, c, false)
			out[i] = llm.Block{
				Type: llm.BlockToolResult, ToolUseID: c.ID, IsError: true,
				Text: fmt.Sprintf("Unknown tool %q. Available: %s", c.Name, a.toolNames()),
			}
			a.finishCognition(ctx, sessionID, ticket, tools.Errf("%s", out[i].Text))
			continue
		}
		mutating := t.Mutates(c.Input)
		if mutating {
			wg.Wait()
			out[i] = a.invoke(ctx, sessionID, c, t, true)
			continue
		}
		wg.Add(1)
		go func(idx int, call llm.Block, tool *tools.Tool) {
			defer wg.Done()
			out[idx] = a.invoke(ctx, sessionID, call, tool, false)
		}(i, c, t)
	}
	wg.Wait()
	return out
}

func (a *Agent) invoke(ctx context.Context, sessionID string, call llm.Block, t *tools.Tool, mutating bool) llm.Block {
	summary := a.env.RedactTestingSecrets(t.Describe(call.Input))
	a.emit("stream/tool", map[string]any{
		"sessionId": sessionID, "id": call.ID, "name": call.Name,
		"status": "running", "input": a.env.RedactTestingInput(call.Input),
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

	res := a.executeTool(ctx, sessionID, call, t, mutating)

	status := "ok"
	a.mu.Lock()
	if sess, ok := a.sessions[sessionID]; ok {
		sess.Usage.Input += res.Usage.Input
		sess.Usage.Output += res.Usage.Output
		sess.Usage.CacheRead += res.Usage.CacheRead
		sess.Usage.CacheWrite += res.Usage.CacheWrite
	}
	a.mu.Unlock()
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
	head, tail := n/2, len(s)-n/2
	for head > 0 && s[head]&0xc0 == 0x80 {
		head--
	}
	for tail < len(s) && s[tail]&0xc0 == 0x80 {
		tail++
	}
	return s[:head] + fmt.Sprintf("\n… [preview omitted %d middle bytes; full output remains in the worker context] …\n", tail-head) + s[tail:]
}

func (a *Agent) toolNames() string {
	list := a.registry.List()
	names := make([]string, 0, len(list))
	for _, t := range list {
		if !a.toolAllowed(t) {
			continue
		}
		names = append(names, t.Name)
	}
	return strings.Join(names, ", ")
}

func (a *Agent) toolAllowed(t *tools.Tool) bool {
	if !tools.QueueToolAllowed(a.cfg.QueueRole, t.Name) {
		return false
	}
	// Shell command classification is for scheduling, not an inspection
	// guarantee. A reviewer uses dedicated read tools instead of arbitrary
	// commands, browser scripts or third-party tools that can change state.
	return !a.cfg.InspectOnly || (!t.Mutating && t.MutatesOn == nil)
}
