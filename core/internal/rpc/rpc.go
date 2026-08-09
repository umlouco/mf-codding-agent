// Package rpc implements bidirectional JSON-RPC 2.0 over newline-delimited
// stdio. The extension host and the core each act as both client and server:
// the extension calls tools/chat on the core, and the core calls back for
// permission prompts and editor-side operations.
package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

type Message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message) }

// Handler processes an inbound request. Returning a non-nil error is
// serialised back to the caller as a JSON-RPC error object.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

type Conn struct {
	in  *bufio.Scanner
	out io.Writer

	writeMu sync.Mutex

	handlers map[string]Handler
	async    map[string]bool
	hMu      sync.RWMutex

	nextID  atomic.Int64
	pending map[int64]chan *Message
	pMu     sync.Mutex

	// cancels tracks in-flight inbound requests so a peer can abort them.
	cancels map[string]context.CancelFunc
	cMu     sync.Mutex

	// inflight counts running handlers so Serve can drain before returning.
	// Without this, closing stdin races the handlers and their replies are
	// lost — which is exactly what happens when the peer pipes a batch of
	// requests and closes.
	inflight sync.WaitGroup
}

func NewConn(in io.Reader, out io.Writer) *Conn {
	sc := bufio.NewScanner(in)
	// Tool results and file contents routinely exceed the 64KB default.
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	return &Conn{
		in:       sc,
		out:      out,
		handlers: map[string]Handler{},
		async:    map[string]bool{},
		pending:  map[int64]chan *Message{},
		cancels:  map[string]context.CancelFunc{},
	}
}

// Register adds a handler that runs inline on the read loop, so requests are
// processed strictly in the order they arrive. This is what callers expect:
// an edit sent before a build must happen before the build.
func (c *Conn) Register(method string, h Handler) {
	c.hMu.Lock()
	defer c.hMu.Unlock()
	c.handlers[method] = h
}

// RegisterAsync adds a handler that runs on its own goroutine. Use it only for
// genuinely long-running work (a chat turn) that must not block the read loop —
// otherwise a cancel or permission reply could never get through.
func (c *Conn) RegisterAsync(method string, h Handler) {
	c.hMu.Lock()
	defer c.hMu.Unlock()
	c.handlers[method] = h
	c.async[method] = true
}

// TrackCancel registers a cancel func under a caller-supplied key (e.g. a
// session id) so that a later `cancel` request can stop the work.
func (c *Conn) TrackCancel(key string, cancel context.CancelFunc) {
	c.cMu.Lock()
	defer c.cMu.Unlock()
	c.cancels[key] = cancel
}

func (c *Conn) Cancel(key string) bool {
	c.cMu.Lock()
	cancel, ok := c.cancels[key]
	delete(c.cancels, key)
	c.cMu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

func (c *Conn) ClearCancel(key string) {
	c.cMu.Lock()
	delete(c.cancels, key)
	c.cMu.Unlock()
}

// Notify sends a fire-and-forget message to the peer.
func (c *Conn) Notify(method string, params any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(&Message{JSONRPC: "2.0", Method: method, Params: raw})
}

// Call issues a request to the peer and blocks for the response.
func (c *Conn) Call(ctx context.Context, method string, params any, result any) error {
	id := c.nextID.Add(1)
	rawID, _ := json.Marshal(id)
	rid := json.RawMessage(rawID)

	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}

	ch := make(chan *Message, 1)
	c.pMu.Lock()
	c.pending[id] = ch
	c.pMu.Unlock()
	defer func() {
		c.pMu.Lock()
		delete(c.pending, id)
		c.pMu.Unlock()
	}()

	if err := c.write(&Message{JSONRPC: "2.0", ID: &rid, Method: method, Params: raw}); err != nil {
		return err
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case msg := <-ch:
		if msg.Error != nil {
			return msg.Error
		}
		if result != nil && len(msg.Result) > 0 {
			return json.Unmarshal(msg.Result, result)
		}
		return nil
	}
}

func (c *Conn) write(m *Message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.out.Write(append(b, '\n')); err != nil {
		return err
	}
	if f, ok := c.out.(interface{ Flush() error }); ok {
		return f.Flush()
	}
	return nil
}

// Serve reads messages until stdin closes. Requests are dispatched on their
// own goroutine so a long-running chat turn never blocks permission replies.
func (c *Conn) Serve(ctx context.Context) error {
	for c.in.Scan() {
		line := c.in.Bytes()
		if len(line) == 0 {
			continue
		}
		buf := make([]byte, len(line))
		copy(buf, line)

		var msg Message
		if err := json.Unmarshal(buf, &msg); err != nil {
			continue
		}

		// A response to something we sent.
		if msg.Method == "" && msg.ID != nil {
			var id int64
			if err := json.Unmarshal(*msg.ID, &id); err == nil {
				c.pMu.Lock()
				ch, ok := c.pending[id]
				c.pMu.Unlock()
				if ok {
					m := msg
					ch <- &m
				}
			}
			continue
		}

		c.hMu.RLock()
		isAsync := c.async[msg.Method]
		c.hMu.RUnlock()

		if isAsync {
			c.inflight.Add(1)
			go func(m Message) {
				defer c.inflight.Done()
				c.dispatch(ctx, &m)
			}(msg)
			continue
		}
		c.dispatch(ctx, &msg)
	}
	err := c.in.Err()
	c.inflight.Wait()
	return err
}

func (c *Conn) dispatch(ctx context.Context, msg *Message) {
	c.hMu.RLock()
	h, ok := c.handlers[msg.Method]
	c.hMu.RUnlock()

	if !ok {
		if msg.ID != nil {
			_ = c.write(&Message{
				JSONRPC: "2.0", ID: msg.ID,
				Error: &RPCError{Code: -32601, Message: "method not found: " + msg.Method},
			})
		}
		return
	}

	res, err := h(ctx, msg.Params)
	if msg.ID == nil {
		return // notification: no reply expected
	}
	if err != nil {
		var rerr *RPCError
		if e, ok := err.(*RPCError); ok {
			rerr = e
		} else {
			rerr = &RPCError{Code: -32000, Message: err.Error()}
		}
		_ = c.write(&Message{JSONRPC: "2.0", ID: msg.ID, Error: rerr})
		return
	}
	raw, mErr := json.Marshal(res)
	if mErr != nil {
		_ = c.write(&Message{JSONRPC: "2.0", ID: msg.ID,
			Error: &RPCError{Code: -32603, Message: mErr.Error()}})
		return
	}
	_ = c.write(&Message{JSONRPC: "2.0", ID: msg.ID, Result: raw})
}
