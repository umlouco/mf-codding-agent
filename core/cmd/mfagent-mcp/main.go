// Command mfagent-mcp is a standalone MCP server that exposes task queue
// operations to any MCP-compatible client. It speaks newline-delimited JSON-RPC
// 2.0 over stdio, matching the 2025-06-18 MCP specification.
//
// The server opens .mfagent/queue.db under the workspace root (the current
// working directory) and exposes four tools:
//
//   - task_queue_create:  add a single task
//   - task_queue_list:    list all tasks with their status
//   - task_queue_stats:   aggregate counts and token usage
//   - task_queue_generate: replace the entire queue with a new plan
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/mflores/mfagent/core/internal/queue"

	_ "modernc.org/sqlite"
)

var version = "0.0.0"

const protocolVersion = "2025-11-25"

var supportedProtocolVersions = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
	"2025-11-25": true,
}

// ---- MCP wire types -------------------------------------------------------

type rpcRequest struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ---- tool registration ----------------------------------------------------

type toolHandler func(ctx context.Context, params json.RawMessage) (string, bool, error)

type registeredTool struct {
	Name         string
	Description  string
	InputSchema  map[string]any
	OutputSchema map[string]any
	Annotations  map[string]any
	Handler      toolHandler
}

// ---- server ---------------------------------------------------------------

type server struct {
	in    *bufio.Scanner
	out   io.Writer
	outMu sync.Mutex

	tools []registeredTool
	db    *queue.DB
}

func main() {
	workspace := flag.String("workspace", "", "workspace root (default: current directory)")
	flag.Parse()

	if *workspace == "" {
		wd, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "mfagent-mcp: cannot determine working directory: %v\n", err)
			os.Exit(1)
		}
		*workspace = wd
	}

	dbPath := filepath.Join(*workspace, ".mfagent", "queue.db")
	db, err := queue.Open(dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mfagent-mcp: cannot open queue database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	s := &server{
		in:  bufio.NewScanner(os.Stdin),
		out: os.Stdout,
		db:  db,
	}
	s.in.Buffer(make([]byte, 0, 1<<20), 64<<20)

	s.registerTools()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		cancel()
	}()

	if err := s.serve(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "mfagent-mcp: %v\n", err)
	}
}

// ---- MCP protocol handlers ------------------------------------------------

func (s *server) serve(ctx context.Context) error {
	for s.in.Scan() {
		line := s.in.Bytes()
		if len(line) == 0 {
			continue
		}

		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		// Responses to our own calls would be matched by ID, but this server
		// only ever replies — it never initiates requests synchronously.
		if req.Method == "" && req.ID != nil {
			continue
		}

		s.dispatch(ctx, &req)
	}
	return s.in.Err()
}

func (s *server) dispatch(ctx context.Context, req *rpcRequest) {
	switch req.Method {
	case "initialize":
		s.handleInitialize(ctx, req)
	case "notifications/initialized":
		// Notification — no response needed.
	case "tools/list":
		s.handleToolsList(ctx, req)
	case "tools/call":
		s.handleToolsCall(ctx, req)
	default:
		if req.ID != nil {
			s.sendError(req.ID, -32601, "method not found: "+req.Method)
		}
	}
}

func (s *server) handleInitialize(_ context.Context, req *rpcRequest) {
	var in struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(req.Params, &in)
	negotiated := protocolVersion
	if supportedProtocolVersions[in.ProtocolVersion] {
		negotiated = in.ProtocolVersion
	}
	result := map[string]any{
		"protocolVersion": negotiated,
		"capabilities": map[string]any{
			"tools": map[string]any{},
		},
		"serverInfo": map[string]any{
			"name":    "mfagent-mcp",
			"title":   "MF Agent Task Queue",
			"version": "0.1.0",
		},
		"instructions": "Use task_queue_write_plan to create task lists. Include ordered, self-contained tasks with implementation and behavior checks. Use dryRun before writing when requirements are uncertain.",
	}
	s.sendResult(req.ID, result)
}

func (s *server) handleToolsList(_ context.Context, req *rpcRequest) {
	type toolEntry struct {
		Name         string         `json:"name"`
		Description  string         `json:"description"`
		InputSchema  map[string]any `json:"inputSchema"`
		OutputSchema map[string]any `json:"outputSchema,omitempty"`
		Annotations  map[string]any `json:"annotations,omitempty"`
	}
	entries := make([]toolEntry, len(s.tools))
	for i, t := range s.tools {
		entries[i] = toolEntry{t.Name, t.Description, t.InputSchema, t.OutputSchema, t.Annotations}
	}
	result := map[string]any{"tools": entries}
	s.sendResult(req.ID, result)
}

func (s *server) handleToolsCall(ctx context.Context, req *rpcRequest) {
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &call); err != nil {
		s.sendError(req.ID, -32602, "invalid params: "+err.Error())
		return
	}

	for _, t := range s.tools {
		if t.Name == call.Name {
			text, isError, err := t.Handler(ctx, call.Arguments)
			if err != nil {
				// Return the error as a tool result with isError: true,
				// not as an RPC error — the tool itself was invoked.
				content, _ := json.Marshal([]map[string]any{
					{"type": "text", "text": err.Error()},
				})
				result := map[string]any{
					"content": json.RawMessage(content),
					"isError": true,
				}
				s.sendResult(req.ID, result)
				return
			}
			content, _ := json.Marshal([]map[string]any{
				{"type": "text", "text": text},
			})
			result := map[string]any{
				"content": json.RawMessage(content),
				"isError": isError,
			}
			var structured any
			if json.Unmarshal([]byte(text), &structured) == nil {
				result["structuredContent"] = structured
			}
			s.sendResult(req.ID, result)
			return
		}
	}

	s.sendError(req.ID, -32602, "unknown tool: "+call.Name)
}

// ---- wire helpers ---------------------------------------------------------

func (s *server) sendResult(id *json.RawMessage, result any) {
	raw, err := json.Marshal(result)
	if err != nil {
		s.sendError(id, -32603, "internal error: "+err.Error())
		return
	}
	s.write(&rpcResponse{JSONRPC: "2.0", ID: id, Result: raw})
}

func (s *server) sendError(id *json.RawMessage, code int, message string) {
	s.write(&rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}})
}

func (s *server) write(resp *rpcResponse) {
	b, err := json.Marshal(resp)
	if err != nil {
		return
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, _ = s.out.Write(append(b, '\n'))
	if f, ok := s.out.(interface{ Flush() error }); ok {
		_ = f.Flush()
	}
}
