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

const protocolVersion = "2025-06-18"

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
	Name        string
	Description string
	InputSchema map[string]any
	Handler     toolHandler
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

func (s *server) registerTools() {
	s.tools = []registeredTool{
		{
			Name:        "task_queue_create",
			Description: "Add a task to the queue. title and description are required.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title":       map[string]any{"type": "string", "description": "Short task title."},
					"description": map[string]any{"type": "string", "description": "What this task should accomplish."},
				},
				"required": []string{"title", "description"},
			},
			Handler: s.onCreate,
		},
		{
			Name:        "task_queue_list",
			Description: "List all tasks currently in the queue, ordered by sequence.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
			Handler: s.onList,
		},
		{
			Name:        "task_queue_stats",
			Description: "Return aggregate statistics: counts by status, token usage, and run state.",
			InputSchema: map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
			Handler: s.onStats,
		},
		{
			Name:        "task_queue_generate",
			Description: "Replace the entire task queue with a new plan. Clears all existing tasks and inserts the provided list.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"tasks": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"title":       map[string]any{"type": "string"},
								"description": map[string]any{"type": "string"},
							},
							"required": []string{"title", "description"},
						},
					},
				},
				"required": []string{"tasks"},
			},
			Handler: s.onGenerate,
		},
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
	// Per MCP 2025-06-18 §3.3.1: the server must report its capabilities.
	result := map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities": map[string]any{
			"tools": map[string]any{},
		},
		"serverInfo": map[string]any{
			"name":    "mfagent-mcp",
			"version": "0.1.0",
		},
	}
	s.sendResult(req.ID, result)
}

func (s *server) handleToolsList(_ context.Context, req *rpcRequest) {
	type toolEntry struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		InputSchema map[string]any `json:"inputSchema"`
	}
	entries := make([]toolEntry, len(s.tools))
	for i, t := range s.tools {
		entries[i] = toolEntry{t.Name, t.Description, t.InputSchema}
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
			s.sendResult(req.ID, result)
			return
		}
	}

	s.sendError(req.ID, -32602, "unknown tool: "+call.Name)
}

// ---- tool handlers --------------------------------------------------------

func (s *server) onCreate(_ context.Context, params json.RawMessage) (string, bool, error) {
	var in struct {
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return "", true, fmt.Errorf("invalid arguments: %w", err)
	}
	if in.Title == "" {
		return "", true, fmt.Errorf("title is required")
	}

	id, err := queue.CreateTask(s.db, in.Title, in.Description)
	if err != nil {
		return "", true, fmt.Errorf("create failed: %w", err)
	}
	out, _ := json.Marshal(map[string]any{"id": id, "title": in.Title})
	return string(out), false, nil
}

func (s *server) onList(_ context.Context, _ json.RawMessage) (string, bool, error) {
	tasks, err := queue.ListTasks(s.db)
	if err != nil {
		return "", true, fmt.Errorf("list failed: %w", err)
	}
	if tasks == nil {
		tasks = []queue.Task{}
	}
	out, _ := json.Marshal(tasks)
	return string(out), false, nil
}

func (s *server) onStats(_ context.Context, _ json.RawMessage) (string, bool, error) {
	stats, err := queue.Stats(s.db)
	if err != nil {
		return "", true, fmt.Errorf("stats failed: %w", err)
	}
	out, _ := json.Marshal(stats)
	return string(out), false, nil
}

func (s *server) onGenerate(_ context.Context, params json.RawMessage) (string, bool, error) {
	var in struct {
		Tasks []struct {
			Title       string `json:"title"`
			Description string `json:"description"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return "", true, fmt.Errorf("invalid arguments: %w", err)
	}
	if len(in.Tasks) == 0 {
		return "", true, fmt.Errorf("tasks array must not be empty")
	}

	nt := make([]queue.NewTask, len(in.Tasks))
	for i, t := range in.Tasks {
		nt[i] = queue.NewTask{Title: t.Title, Description: t.Description}
	}

	if err := queue.ReplaceAll(s.db, nt); err != nil {
		return "", true, fmt.Errorf("generate failed: %w", err)
	}

	result := map[string]any{"replaced": true, "count": len(nt)}
	out, _ := json.Marshal(result)
	return string(out), false, nil
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
