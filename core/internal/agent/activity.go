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

One condition does end a call: silence on the wire. Bytes arriving mean the far
end is alive however slowly it is working, so every read resets the window;
bytes having stopped for the whole window means the connection is gone, and
saying so is more useful than waiting on it forever.
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
	defaultLLMIdle = 30 * time.Minute
	// How often a waiting turn writes that it is still waiting.
	defaultActivityInterval = 30 * time.Second
)

func (a *Agent) llmIdle() time.Duration {
	if n := a.cfg.LLMIdleSeconds; n > 0 {
		return time.Duration(n) * time.Second
	}
	return defaultLLMIdle
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

The watch does two things and nothing else. It keeps writing for as long as the
call is in flight, so silence in the journal means a dead worker rather than a
busy one. And it cancels the call when the connection has delivered nothing for
the whole idle window — the one condition that is never a slow model.
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
		lastByte  atomic.Int64 // unix nanos of the most recent read
		total     atomic.Int64 // bytes read on this call
		streaming atomic.Bool  // the reply has started arriving
		stalled   atomic.Bool
	)
	lastByte.Store(time.Now().UnixNano())

	watched := func(ev llm.Event) {
		lastByte.Store(time.Now().UnixNano())
		if ev.Kind == llm.EventWire {
			total.Add(int64(ev.Bytes))
			streaming.Store(true)
			return // liveness only — never content
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
				if idle >= a.llmIdle() {
					stalled.Store(true)
					a.activity(sessionID, PhaseStalled, fmt.Sprintf(
						"%s has delivered nothing for %s — dropping the connection",
						a.provider.Name(), brief(idle)))
					cancel()
					return
				}
				phase, what := PhaseModel, fmt.Sprintf("waiting for the first token from %s", a.provider.Model())
				if streaming.Load() {
					phase = PhaseStreaming
					what = fmt.Sprintf("receiving the reply — %d bytes so far", total.Load())
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
