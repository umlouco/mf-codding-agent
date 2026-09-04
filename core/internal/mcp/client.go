// Package mcp implements a minimal Model Context Protocol client covering the
// two transports that matter for a desktop editor: a local process over stdio,
// and streamable HTTP. It deliberately implements only the tools half of the
// protocol — initialize, tools/list, tools/call — which is what an agent needs.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const protocolVersion = "2025-06-18"

type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	Data string `json:"data,omitempty"`
	// Resource links and embedded resources are flattened to text.
	URI      string `json:"uri,omitempty"`
	MIMEType string `json:"mimeType,omitempty"`
}

type callResult struct {
	Content []contentBlock `json:"content"`
	IsError bool           `json:"isError"`
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Client is one connected MCP server.
type Client struct {
	Name  string
	Tools []Tool

	transport transport
	nextID    atomic.Int64
	mu        sync.Mutex
	closed    bool
}

type transport interface {
	send(ctx context.Context, req *rpcReq) (*rpcResp, error)
	notify(ctx context.Context, req *rpcReq) error
	close() error
}

// ---- stdio transport ---------------------------------------------------

type stdioTransport struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner

	mu      sync.Mutex
	pending map[int64]chan *rpcResp
	readErr error
	once    sync.Once
}

func newStdio(ctx context.Context, command string, args []string, env map[string]string, cwd string) (*stdioTransport, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// MCP servers habitually log to stderr; keep it off our stdout channel.
	cmd.Stderr = io.Discard

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting %s: %w", command, err)
	}

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1<<20), 32<<20)

	t := &stdioTransport{cmd: cmd, stdin: stdin, stdout: sc, pending: map[int64]chan *rpcResp{}}
	go t.readLoop()
	return t, nil
}

func (t *stdioTransport) readLoop() {
	for t.stdout.Scan() {
		line := bytes.TrimSpace(t.stdout.Bytes())
		if len(line) == 0 {
			continue
		}
		var resp rpcResp
		if json.Unmarshal(line, &resp) != nil || resp.ID == 0 {
			continue // notification or garbage from the server
		}
		t.mu.Lock()
		ch, ok := t.pending[resp.ID]
		delete(t.pending, resp.ID)
		t.mu.Unlock()
		if ok {
			r := resp
			ch <- &r
		}
	}
	t.mu.Lock()
	t.readErr = fmt.Errorf("mcp server closed its output stream")
	for id, ch := range t.pending {
		close(ch)
		delete(t.pending, id)
	}
	t.mu.Unlock()
}

func (t *stdioTransport) write(req *rpcReq) error {
	b, err := json.Marshal(req)
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.readErr != nil {
		return t.readErr
	}
	_, err = t.stdin.Write(append(b, '\n'))
	return err
}

func (t *stdioTransport) send(ctx context.Context, req *rpcReq) (*rpcResp, error) {
	ch := make(chan *rpcResp, 1)
	t.mu.Lock()
	t.pending[req.ID] = ch
	t.mu.Unlock()

	if err := t.write(req); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		t.mu.Lock()
		delete(t.pending, req.ID)
		t.mu.Unlock()
		return nil, ctx.Err()
	case resp, ok := <-ch:
		if !ok || resp == nil {
			return nil, fmt.Errorf("mcp server disconnected")
		}
		return resp, nil
	}
}

func (t *stdioTransport) notify(ctx context.Context, req *rpcReq) error { return t.write(req) }

func (t *stdioTransport) close() error {
	t.once.Do(func() {
		_ = t.stdin.Close()
		done := make(chan struct{})
		go func() { _ = t.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = t.cmd.Process.Kill()
		}
	})
	return nil
}

// ---- streamable HTTP transport ----------------------------------------

type httpTransport struct {
	url       string
	headers   map[string]string
	client    *http.Client
	sessionID string
	mu        sync.Mutex
}

func newHTTP(url string, headers map[string]string) *httpTransport {
	return &httpTransport{
		url: url, headers: headers,
		client: &http.Client{Timeout: 120 * time.Second},
	}
}

func (t *httpTransport) do(ctx context.Context, req *rpcReq) (*rpcResp, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range t.headers {
		hreq.Header.Set(k, v)
	}
	t.mu.Lock()
	sid := t.sessionID
	t.mu.Unlock()
	if sid != "" {
		hreq.Header.Set("Mcp-Session-Id", sid)
	}

	resp, err := t.client.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if s := resp.Header.Get("Mcp-Session-Id"); s != "" {
		t.mu.Lock()
		t.sessionID = s
		t.mu.Unlock()
	}
	if resp.StatusCode == http.StatusAccepted {
		return nil, nil // notification acknowledged
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := fmt.Sprintf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
		// A 401 usually names the scheme it wanted, and that is the difference
		// between a wrong key and a right key sent the wrong way; pass it on.
		if wa := resp.Header.Get("WWW-Authenticate"); wa != "" {
			msg += " (server asks for: " + wa + ")"
		}
		return nil, fmt.Errorf("%s", msg)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	// Streamable HTTP may answer with SSE; take the last data: frame.
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		var last []byte
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "data:") {
				last = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		raw = last
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	var out rpcResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("bad response: %w", err)
	}
	return &out, nil
}

func (t *httpTransport) send(ctx context.Context, req *rpcReq) (*rpcResp, error) {
	r, err := t.do(ctx, req)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, fmt.Errorf("empty response")
	}
	return r, nil
}

func (t *httpTransport) notify(ctx context.Context, req *rpcReq) error {
	_, err := t.do(ctx, req)
	return err
}

func (t *httpTransport) close() error { return nil }

// ---- client ------------------------------------------------------------

type ServerSpec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
	URL     string
	Headers map[string]string
	Cwd     string
}

func Connect(ctx context.Context, spec ServerSpec) (*Client, error) {
	var tr transport
	var err error
	switch {
	case spec.URL != "":
		tr = newHTTP(spec.URL, spec.Headers)
	case spec.Command != "":
		tr, err = newStdio(ctx, spec.Command, spec.Args, spec.Env, spec.Cwd)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("server %q needs either a command or a url", spec.Name)
	}

	c := &Client{Name: spec.Name, transport: tr}

	initCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	if _, err := c.call(initCtx, "initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"clientInfo":      map[string]any{"name": "mfagent", "version": "0.1.0"},
	}); err != nil {
		tr.close()
		return nil, fmt.Errorf("initialize: %w", err)
	}
	_ = tr.notify(initCtx, &rpcReq{JSONRPC: "2.0", Method: "notifications/initialized"})

	if err := c.refreshTools(initCtx); err != nil {
		tr.close()
		return nil, fmt.Errorf("tools/list: %w", err)
	}
	return c, nil
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("client closed")
	}
	c.mu.Unlock()

	req := &rpcReq{JSONRPC: "2.0", ID: c.nextID.Add(1), Method: method, Params: params}
	resp, err := c.transport.send(ctx, req)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("%s (code %d)", resp.Error.Message, resp.Error.Code)
	}
	return resp.Result, nil
}

func (c *Client) refreshTools(ctx context.Context) error {
	raw, err := c.call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return err
	}
	var out struct {
		Tools      []Tool `json:"tools"`
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return err
	}
	c.Tools = out.Tools

	// Follow pagination so large servers expose everything.
	for out.NextCursor != "" {
		raw, err := c.call(ctx, "tools/list", map[string]any{"cursor": out.NextCursor})
		if err != nil {
			break
		}
		prev := out.NextCursor
		out.NextCursor = ""
		if json.Unmarshal(raw, &out) != nil || out.NextCursor == prev {
			break
		}
		c.Tools = append(c.Tools, out.Tools...)
	}
	return nil
}

// CallTool invokes a tool and flattens the content blocks to text.
func (c *Client) CallTool(ctx context.Context, name string, args json.RawMessage) (string, bool, error) {
	var parsed any
	if len(args) > 0 {
		if err := json.Unmarshal(args, &parsed); err != nil {
			parsed = map[string]any{}
		}
	} else {
		parsed = map[string]any{}
	}
	raw, err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": parsed})
	if err != nil {
		return "", true, err
	}
	var res callResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return string(raw), false, nil
	}
	var sb strings.Builder
	for _, b := range res.Content {
		switch b.Type {
		case "text":
			sb.WriteString(b.Text)
			sb.WriteByte('\n')
		case "image":
			fmt.Fprintf(&sb, "[image: %s, %d base64 bytes]\n", b.MIMEType, len(b.Data))
		case "resource", "resource_link":
			fmt.Fprintf(&sb, "[resource: %s %s]\n", b.MIMEType, b.URI)
		default:
			fmt.Fprintf(&sb, "[%s block]\n", b.Type)
		}
	}
	out := strings.TrimRight(sb.String(), "\n")
	if out == "" {
		out = "(tool returned no content)"
	}
	return out, res.IsError, nil
}

func (c *Client) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	return c.transport.close()
}

// ---- manager -----------------------------------------------------------

type Manager struct {
	mu      sync.RWMutex
	clients map[string]*Client
	errs    map[string]string
}

func NewManager() *Manager {
	return &Manager{clients: map[string]*Client{}, errs: map[string]string{}}
}

func (m *Manager) Connect(ctx context.Context, spec ServerSpec) (*Client, error) {
	c, err := Connect(ctx, spec)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		m.errs[spec.Name] = err.Error()
		return nil, err
	}
	delete(m.errs, spec.Name)
	if old, ok := m.clients[spec.Name]; ok {
		_ = old.Close()
	}
	m.clients[spec.Name] = c
	return c, nil
}

func (m *Manager) Get(name string) (*Client, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.clients[name]
	return c, ok
}

type Status struct {
	Name  string   `json:"name"`
	Tools []string `json:"tools"`
	Error string   `json:"error,omitempty"`
}

func (m *Manager) Status() []Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Status
	for name, c := range m.clients {
		s := Status{Name: name}
		for _, t := range c.Tools {
			s.Tools = append(s.Tools, t.Name)
		}
		out = append(out, s)
	}
	for name, e := range m.errs {
		out = append(out, Status{Name: name, Error: e})
	}
	return out
}

func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, c := range m.clients {
		_ = c.Close()
		delete(m.clients, name)
	}
}
