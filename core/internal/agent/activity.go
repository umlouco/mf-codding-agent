package agent

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/mflores/mfagent/core/internal/llm"
)

/*
Observable progress, without deadlines.

Nothing in this file caps how long anything may take. A local model can spend
hours on a single reply, and a queue worker driving one can spend a day on a
single task; both are legitimate work and neither should be killed for taking
its time. What an observer actually needs is not a budget but evidence, so a
turn writes a timestamped record of what it is doing — including while it sits
waiting on the model, which is exactly the state that is otherwise
indistinguishable from a hang.

That inverts how a stuck worker is detected. Instead of asking "has this run
longer than it was allowed", which punishes slow models, the question becomes
"has this written anything lately", which only ever punishes dead ones.

An optional transport idle window can end a call that delivers no bytes. A
silent local model may still be loading or doing prefill, so callers can disable
this window and wait until completion, a transport error, or explicit cancellation.
*/

// Phases an observer can act on. They go into the journal verbatim.
const (
	PhaseModel     = "model_wait"   // request sent, nothing back yet
	PhaseStreaming = "model_stream" // the reply is arriving
	PhaseTool      = "tool"         // running tool calls
	PhaseReport    = "report"       // writing the closing handoff report
	PhaseStalled   = "stalled"      // the connection stopped delivering
	PhaseDone      = "done"
	PhaseError     = "error"
)

const (
	// How long a reply may deliver nothing at all before the connection counts
	// as dropped. Generous on purpose: a local model loading a large set of
	// weights can take a long time to produce its first token.
	defaultLLMIdle = 60 * time.Minute
	// How often a waiting turn writes that it is still waiting.
	defaultActivityInterval = 30 * time.Second
)

func (a *Agent) llmIdle() time.Duration {
	if a.cfg.LLMIdleSeconds < 0 {
		return 0 // Explicitly disabled: slow prefill may deliver no bytes for hours.
	}
	if n := a.cfg.LLMIdleSeconds; n > 0 {
		return time.Duration(n) * time.Second
	}
	return defaultLLMIdle
}

// repeatBytes is how many identical consecutive bytes of model text mark a
// reply as degenerate. 0 disables the guard for callers that want a
// deliberately repetitive reply preserved.
func (a *Agent) repeatBytes() int {
	if a.cfg.LLMRepeatBytes < 0 {
		return 0
	}
	if n := a.cfg.LLMRepeatBytes; n > 0 {
		return n
	}
	return repetitionMinBytes
}

func (a *Agent) activityInterval() time.Duration {
	if n := a.cfg.ActivitySeconds; n > 0 {
		return time.Duration(n) * time.Second
	}
	return defaultActivityInterval
}

// activity writes one timestamped record of what this turn is doing. The editor
// persists these, so anything written here survives the process that wrote it.
func (a *Agent) activity(sessionID, phase, detail string) {
	a.emit("agent/activity", map[string]any{
		"sessionId": sessionID,
		"phase":     phase,
		"detail":    detail,
		"at":        time.Now().UnixMilli(),
	})
}

/*
beat writes "still going" records until the returned stop func is called.

Long tool calls need this as much as long model replies do. A twenty-minute test
run that wrote nothing to the journal would look exactly like a dead worker, and
the whole point of judging liveness by silence is that it must not accuse work
that is simply slow.
*/
func (a *Agent) beat(sessionID, phase string, what func(time.Duration) string) (stop func()) {
	done := make(chan struct{})
	stopped := make(chan struct{})
	started := time.Now()

	go func() {
		defer close(stopped)
		tick := time.NewTicker(a.activityInterval())
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				a.activity(sessionID, phase, what(time.Since(started)))
			}
		}
	}()

	return func() {
		close(done)
		<-stopped
	}
}

/*
stream runs one provider call under an activity watch.

The watch does three things and nothing else. It keeps writing for as long as
the call is in flight, so silence in the journal means a dead worker rather than
a busy one. If explicitly enabled, the idle guard cancels a connection that has
delivered nothing for its configured window. And when repetition reporting is
enabled, it cancels a reply that has collapsed into repeating itself: bytes are
still arriving, so the idle guard cannot see that failure, but the reply is
finished as work regardless — see repetition.go.
*/
func (a *Agent) stream(
	ctx context.Context,
	sessionID string,
	req llm.Request,
	sink func(llm.Event),
) (*llm.Turn, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		lastByte    atomic.Int64 // unix nanos of the most recent read
		total       atomic.Int64 // bytes read on this call
		decoded     atomic.Int64 // actual model content, excluding SSE keepalives
		arguments   atomic.Int64 // generated tool arguments, never their contents
		lastContent atomic.Int64
		streaming   atomic.Bool // decoded model output has started arriving
		stalled     atomic.Bool
		degenerate  atomic.Bool // the reply collapsed into a repeated block
	)
	lastByte.Store(time.Now().UnixNano())
	lastContent.Store(time.Now().UnixNano())

	// Only armed when the caller allows it. Tool arguments are deliberately not
	// observed: a generated file can be long, and large repetition inside one is
	// the model doing its job, not rambling.
	var repetitions *repetitionGuard
	if limit := a.repeatBytes(); limit > 0 {
		repetitions = newRepetitionGuard(limit)
	}

	// stopIfDegenerate cuts a reply that has collapsed into a repeated block.
	// It is called both as text arrives and on the activity tick, so a loop is
	// caught within seconds of crossing the threshold rather than at the next
	// slow heartbeat. The record and the cancellation happen exactly once.
	stopIfDegenerate := func() {
		if repetitions == nil {
			return
		}
		bad, detail := repetitions.check()
		if !bad || !degenerate.CompareAndSwap(false, true) {
			return
		}
		a.activity(sessionID, PhaseError, fmt.Sprintf(
			"%s: %s — stopping the reply instead of waiting for it to finish",
			a.provider.Model(), detail))
		cancel()
	}

	watched := func(ev llm.Event) {
		lastByte.Store(time.Now().UnixNano())
		if ev.Kind == llm.EventWire {
			total.Add(int64(ev.Bytes))
			return // liveness only — never content
		}
		if ev.Kind == llm.EventToolInput && ev.Bytes > 0 {
			streaming.Store(true)
			arguments.Add(int64(ev.Bytes))
			decoded.Add(int64(ev.Bytes))
			lastContent.Store(time.Now().UnixNano())
		}
		if ((ev.Kind == llm.EventText || ev.Kind == llm.EventThinking) && ev.Text != "") || ev.Kind == llm.EventToolStart {
			streaming.Store(true)
			decoded.Add(int64(len(ev.Text)))
			lastContent.Store(time.Now().UnixNano())
			if repetitions != nil && ev.Kind != llm.EventToolStart && repetitions.observe(ev.Text) {
				stopIfDegenerate()
			}
		}
		sink(ev)
	}

	started := time.Now()
	stop := make(chan struct{})
	watching := make(chan struct{})

	go func() {
		defer close(watching)
		tick := time.NewTicker(a.activityInterval())
		defer tick.Stop()

		for {
			select {
			case <-stop:
				return
			case now := <-tick.C:
				idle := now.Sub(time.Unix(0, lastByte.Load()))
				if limit := a.llmIdle(); limit > 0 && idle >= limit {
					stalled.Store(true)
					a.activity(sessionID, PhaseStalled, fmt.Sprintf(
						"%s has delivered nothing for %s — dropping the connection",
						a.provider.Name(), brief(idle)))
					cancel()
					return
				}
				// Bytes keep arriving, but if they are the same bytes over and
				// over the reply is not progressing — see repetition.go. This is
				// the failure the idle guard above cannot see: a local model
				// that stays busy repeating one phrase forever. The per-event
				// check in watched normally catches it first; this is the
				// backstop for a loop that only spans tick boundaries.
				stopIfDegenerate()
				if degenerate.Load() {
					return
				}
				phase, what := PhaseModel, fmt.Sprintf("waiting for the first token from %s", a.provider.Model())
				if streaming.Load() {
					phase = PhaseStreaming
					what = fmt.Sprintf("receiving model output — %d decoded bytes, last model output %s ago",
						decoded.Load(), brief(now.Sub(time.Unix(0, lastContent.Load()))))
					if n := arguments.Load(); n > 0 {
						what += fmt.Sprintf(" (%d tool argument bytes)", n)
					}
				} else if total.Load() > 0 {
					what += fmt.Sprintf("; connection alive (%d transport bytes), no model output yet", total.Load())
					if now.Sub(started) >= 90*time.Second {
						what += "; transport activity does not confirm model progress; check the model server for queued requests, prompt processing, or load errors"
					}
				}
				a.activity(sessionID, phase, fmt.Sprintf(
					"%s, %s in, last data %s ago", what, brief(time.Since(started)), brief(idle)))
			}
		}
	}()

	// The sink goes in twice on purpose: a backend that owns its own reads takes
	// it as the argument, while one that hands reading to a vendor SDK picks it
	// up off the context. Both end up reporting the same bytes.
	turn, err := a.provider.Stream(llm.WithWireSink(ctx, watched), req, watched)
	close(stop)
	<-watching

	switch {
	case stalled.Load():
		err = fmt.Errorf(
			"the connection to %s delivered nothing for %s and was dropped — the endpoint "+
				"may be down, or the model may have failed to load", a.provider.Name(), brief(a.llmIdle()))
		a.activity(sessionID, PhaseError, err.Error())
		return nil, err
	case degenerate.Load():
		detail := ""
		if repetitions != nil {
			_, detail = repetitions.check()
		}
		err = fmt.Errorf(
			"the reply from %s degenerated into repetition and was stopped after %s — %s; "+
				"the work it had already reported stands, and the task should be retried rather "+
				"than waiting for this reply", a.provider.Name(), brief(time.Since(started)), detail)
		a.activity(sessionID, PhaseError, err.Error())
		return nil, err
	case err != nil:
		a.activity(sessionID, PhaseError, fmt.Sprintf(
			"%s failed after %s: %v", a.provider.Name(), brief(time.Since(started)), err))
		return nil, err
	}

	a.activity(sessionID, PhaseStreaming, fmt.Sprintf(
		"reply complete in %s — %d bytes, %d in / %d out tokens",
		brief(time.Since(started)), total.Load(), turn.Usage.Input, turn.Usage.Output))
	return turn, nil
}

// brief trims a duration to something readable at a glance.
func brief(d time.Duration) time.Duration {
	if d >= time.Minute {
		return d.Round(time.Second)
	}
	return d.Round(100 * time.Millisecond)
}
