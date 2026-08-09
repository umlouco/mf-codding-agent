package llm

import (
	"context"
	"io"
	"net/http"
)

/*
Wire-level liveness.

A slow model and a dead connection look identical from the outside: no reply.
Telling them apart is the whole reason this exists, because the alternative —
capping how long a reply may take — is wrong for a local model that legitimately
spends hours on one answer.

So every byte read off a streaming response is reported as an EventWire. Bytes
arriving means the far end is alive, no matter how slowly they arrive; bytes
having stopped is the only thing that ever justifies giving up. Providers wire
this up in whichever way suits them: a backend that owns its own reads wraps the
body directly, while one that hands reading to a vendor SDK installs
WireTransport so the wrapping happens under the SDK instead.
*/

// WireReader reports every read off a response body before passing it on.
type WireReader struct {
	R    io.ReadCloser
	Sink func(Event)
}

func (w *WireReader) Read(p []byte) (int, error) {
	n, err := w.R.Read(p)
	if n > 0 && w.Sink != nil {
		w.Sink(Event{Kind: EventWire, Bytes: n})
	}
	return n, err
}

func (w *WireReader) Close() error { return w.R.Close() }

type wireKey struct{}

// WithWireSink carries the sink down to a transport that has no other way to
// reach the caller — the Anthropic SDK builds and owns the request itself.
func WithWireSink(ctx context.Context, sink func(Event)) context.Context {
	return context.WithValue(ctx, wireKey{}, sink)
}

func wireSink(ctx context.Context) func(Event) {
	s, _ := ctx.Value(wireKey{}).(func(Event))
	return s
}

// WireTransport wraps every response body it returns in a WireReader, so reads
// made deep inside an SDK still report liveness.
type WireTransport struct{ Base http.RoundTripper }

func (t *WireTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(r)
	if err != nil || resp.Body == nil {
		return resp, err
	}
	if sink := wireSink(r.Context()); sink != nil {
		resp.Body = &WireReader{R: resp.Body, Sink: sink}
	}
	return resp, nil
}
