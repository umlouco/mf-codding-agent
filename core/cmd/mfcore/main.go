// Command mfcore is the compiled backend for the MF Agent VS Code extension.
//
// It speaks newline-delimited JSON-RPC 2.0 over stdio. Everything that matters
// lives here — the agent loop, tools, graph memory, MCP clients and browser
// control — so the TypeScript side stays a thin transport and UI shell.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/mflores/mfagent/core/internal/agent"
	"github.com/mflores/mfagent/core/internal/browser"
	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/memory"
	"github.com/mflores/mfagent/core/internal/rpc"
	"github.com/mflores/mfagent/core/internal/tools"
)

var version = "0.1.0"

type server struct {
	conn     *rpc.Conn
	cfg      *config.Config
	registry *tools.Registry
	env      *tools.Env
	mem      *memory.Store
	mcpMgr   *mcp.Manager
	brw      *browser.Browser
	ag       *agent.Agent

	sessionMu sync.Mutex
	curSess   string
}

func main() {
	// Subcommands are checked before flag parsing so `mfcore sh` can own its own
	// flags. With no subcommand this is the JSON-RPC server it has always been.
	if len(os.Args) > 1 && os.Args[1] == "sh" {
		os.Exit(runSh(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "scan" {
		os.Exit(runScan(os.Args[2:]))
	}

	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	out := bufio.NewWriterSize(os.Stdout, 1<<16)
	conn := rpc.NewConn(os.Stdin, out)

	s := &server{
		conn:     conn,
		registry: tools.NewRegistry(),
		mcpMgr:   mcp.NewManager(),
	}
	s.register()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		s.shutdown()
		cancel()
		os.Exit(0)
	}()

	if err := conn.Serve(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "mfcore:", err)
	}
	s.shutdown()
}

func (s *server) shutdown() {
	if s.mcpMgr != nil {
		s.mcpMgr.CloseAll()
	}
	if s.brw != nil {
		s.brw.Close()
	}
	if s.mem != nil {
		_ = s.mem.Close()
	}
	tools.KillAllBgProcs()
}

func (s *server) log(level, msg string) {
	_ = s.conn.Notify("log", map[string]any{"level": level, "message": msg})
}

func (s *server) register() {
	s.conn.Register("initialize", s.onInitialize)
	// A chat turn runs for minutes; it must not block cancels or the
	// permission round-trip, so it is the one async handler.
	s.conn.RegisterAsync("chat/send", s.onSend)
	s.conn.Register("chat/cancel", s.onCancel)
	s.conn.Register("chat/reset", s.onReset)
	s.conn.Register("tools/list", s.onToolsList)
	s.conn.Register("tools/invoke", s.onToolsInvoke)
	s.conn.Register("memory/stats", s.onMemoryStats)
	s.conn.Register("memory/graph", s.onMemoryGraph)
	s.conn.Register("memory/search", s.onMemorySearch)
	s.conn.Register("memory/forget", s.onMemoryForget)
	s.conn.Register("memory/lessons", s.onMemoryLessons)
	s.conn.Register("memory/lessonUpsert", s.onMemoryLessonUpsert)
	s.conn.Register("memory/lessonDelete", s.onMemoryLessonDelete)
	s.conn.Register("mcp/status", s.onMCPStatus)
	s.conn.Register("browser/close", s.onBrowserClose)
	s.conn.Register("shutdown", func(ctx context.Context, _ json.RawMessage) (any, error) {
		s.shutdown()
		return map[string]any{"ok": true}, nil
	})
}

// ---- initialize --------------------------------------------------------

type initResult struct {
	Version   string   `json:"version"`
	Provider  string   `json:"provider"`
	Model     string   `json:"model"`
	Tools     []string `json:"tools"`
	Memory    bool     `json:"memory"`
	MemPath   string   `json:"memoryPath,omitempty"`
	Vision    string   `json:"visionModel,omitempty"`
	Embedding string   `json:"embeddingModel,omitempty"`
	MCP       []string `json:"mcp,omitempty"`
	Warnings  []string `json:"warnings,omitempty"`
}

func (s *server) onInitialize(ctx context.Context, params json.RawMessage) (any, error) {
	var cfg config.Config
	if err := json.Unmarshal(params, &cfg); err != nil {
		return nil, fmt.Errorf("bad configuration: %w", err)
	}
	cfg.ApplyDefaults()
	if cfg.WorkspaceRoot == "" {
		wd, _ := os.Getwd()
		cfg.WorkspaceRoot = wd
	}
	s.cfg = &cfg

	var warnings []string

	s.env = &tools.Env{
		Root: cfg.WorkspaceRoot,
		Ask:  s.ask,
		Emit: func(kind string, payload any) {
			_ = s.conn.Notify("stream/event", map[string]any{"kind": kind, "payload": payload})
		},
		FileChanged: func(path string) {
			_ = s.conn.Notify("file/changed", map[string]any{"path": path})
		},
	}

	tools.RegisterFS(s.registry)
	tools.RegisterSearch(s.registry)
	tools.RegisterPosix(s.registry)
	tools.RegisterShell(s.registry)
	tools.RegisterShellBg(s.registry)

	// Graph memory.
	embModel, embKey, embBaseURL := cfg.ResolveEmbedding()
	if cfg.MemoryEnabled {
		store, err := memory.Open(cfg.MemoryPath)
		if err != nil {
			warnings = append(warnings, "graph memory unavailable: "+err.Error())
		} else {
			s.mem = store
			// A degraded store is still a working store, so none of this is
			// fatal — but it must be said out loud. Silent keyword-only search
			// looks exactly like a healthy store from the outside.
			store.Warn = func(msg string) {
				_ = s.conn.Notify("log", map[string]any{"level": "warn", "message": msg})
			}
			// Vector search is optional; without an embedding role the store
			// falls back to keyword matching rather than failing.
			if embModel != "" && embBaseURL != "" {
				emb := memory.NewEmbeddingClient(embBaseURL, embKey, embModel)
				if emb.Enabled() {
					store.SetEmbedder(emb)
				}
			}
			if !store.HasEmbedder() {
				warnings = append(warnings,
					"Graph memory is running keyword-only: no embedding model is bound, so "+
						"nothing will be sent to an embedding server and semantic recall is off. "+
						"Bind the Embedding role on the MF Agent settings page to turn it on.")
			}
			tools.RegisterMemory(s.registry, store, func() string {
				s.sessionMu.Lock()
				defer s.sessionMu.Unlock()
				return s.curSess
			})
		}
	}

	// Browser control.
	shotDir := filepath.Join(cfg.WorkspaceRoot, ".mfagent", "screenshots")
	s.brw = browser.New(cfg.BrowserExecutable, cfg.BrowserHeadless, shotDir)
	tools.RegisterBrowser(s.registry, s.brw)

	// MCP servers, connected in parallel so one slow server does not stall
	// activation.
	var mcpNames []string
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, spec := range cfg.MCPServers {
		if !spec.IsEnabled() {
			continue
		}
		wg.Add(1)
		go func(spec config.MCPServer) {
			defer wg.Done()
			client, err := s.mcpMgr.Connect(ctx, mcp.ServerSpec{
				Name: spec.Name, Command: spec.Command, Args: spec.Args,
				Env: spec.Env, URL: spec.URL, Headers: spec.Headers,
				Cwd: cfg.WorkspaceRoot,
			})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("MCP server %q: %v", spec.Name, err))
				return
			}
			mcpNames = append(mcpNames, spec.Name)
			s.registerMCPTools(spec.Name, client)
		}(spec)
	}
	wg.Wait()

	// LLM provider — resolved from the providers list via the coding role.
	provType, provModel, provKey, provBase, provEffort := cfg.ResolveRole(cfg.Coding)
	if provEffort == "" && provType == "anthropic" {
		// Preserves the previous unconditional behaviour for anyone who has
		// not picked an effort yet — Claude has no "provider default" of its
		// own to fall back to the way a reasoning model on an OpenAI-compatible
		// endpoint does, so the core has always had to pick one.
		provEffort = "xhigh"
	}
	provider := llm.NewProvider(provType, provBase, provKey, provModel, 64000, provEffort, "adaptive")
	if provModel == "" {
		warnings = append(warnings,
			"No coding model is set. Run \"MF Agent: Settings\" and bind a provider to the Coding role.")
	} else if provKey == "" && provType == "anthropic" {
		warnings = append(warnings,
			"No API key for the coding provider. Add one on the MF Agent settings page.")
	}

	// Docgen tool — markdown + screenshot documentation.
	tools.RegisterDocgen(s.registry, s.brw, s.env, provider)

	_, visModel, _, _, _ := cfg.ResolveRole(cfg.Vision)

	system := agent.BuildSystemPrompt(agent.PromptInput{
		WorkspaceRoot: cfg.WorkspaceRoot,
		Languages:     cfg.Languages,
		MemoryEnabled: s.mem != nil,
		BrowserReady:  true,
		MCPServers:    mcpNames,
		ProjectFacts:  agent.LoadProjectInstructions(cfg.WorkspaceRoot),
	})

	s.ag = agent.New(&cfg, provider, s.registry, s.env,
		func(method string, payload any) { _ = s.conn.Notify(method, payload) }, system)

	var toolNames []string
	for _, t := range s.registry.List() {
		toolNames = append(toolNames, t.Name)
	}

	res := &initResult{
		Version: version, Provider: provType, Model: provModel,
		Tools: toolNames, Memory: s.mem != nil, MCP: mcpNames, Warnings: warnings,
		Vision: visModel,
	}
	if s.mem != nil {
		res.MemPath = s.mem.Path()
		// Only report an embedding model that was actually wired up — a
		// configured-but-unreachable one would read as working.
		if s.mem.HasEmbedder() {
			res.Embedding = embModel
		}
	}
	return res, nil
}

func (s *server) registerMCPTools(server string, client *mcp.Client) {
	for _, t := range client.Tools {
		name := fmt.Sprintf("mcp__%s__%s", sanitize(server), sanitize(t.Name))
		toolName := t.Name
		desc := t.Description
		if desc == "" {
			desc = "Tool " + toolName + " provided by MCP server " + server + "."
		}
		schema := t.InputSchema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		s.registry.Add(&tools.Tool{
			Name:        name,
			Description: desc + fmt.Sprintf(" (via MCP server %q)", server),
			Schema:      schema,
			Mutating: true, // an external server's side effects are unknown
			Summarize: func(json.RawMessage) string {
				return fmt.Sprintf("Call %s on MCP server %s", toolName, server)
			},
			Run: func(ctx context.Context, env *tools.Env, in json.RawMessage) tools.Result {
				out, isErr, err := client.CallTool(ctx, toolName, in)
				if err != nil {
					return tools.Errf("MCP call failed: %v", err)
				}
				return tools.Result{Output: out, IsError: isErr}
			},
		})
	}
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// ---- permission gate ---------------------------------------------------

func (s *server) ask(ctx context.Context, tool, summary string, input any) (bool, error) {
	if s.cfg != nil && s.cfg.IsAutoApproved(tool) {
		return true, nil
	}
	var reply struct {
		Approved  bool `json:"approved"`
		AlwaysAllow bool `json:"alwaysAllow"`
	}
	err := s.conn.Call(ctx, "permission/request", map[string]any{
		"tool": tool, "summary": summary, "input": input,
	}, &reply)
	if err != nil {
		return false, err
	}
	if reply.AlwaysAllow && s.cfg != nil {
		s.cfg.AutoApprove = append(s.cfg.AutoApprove, tool)
	}
	return reply.Approved, nil
}

// ---- chat --------------------------------------------------------------

func (s *server) onSend(ctx context.Context, params json.RawMessage) (any, error) {
	if s.ag == nil {
		return nil, fmt.Errorf("core is not initialized")
	}
	var req agent.SendRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if req.SessionID == "" {
		req.SessionID = "default"
	}

	s.sessionMu.Lock()
	s.curSess = req.SessionID
	s.sessionMu.Unlock()

	cctx, cancel := context.WithCancel(context.Background())
	s.conn.TrackCancel(req.SessionID, cancel)
	defer func() {
		s.conn.ClearCancel(req.SessionID)
		cancel()
	}()

	res, err := s.ag.Send(cctx, req)
	if err != nil {
		if cctx.Err() != nil {
			_ = s.conn.Notify("stream/done", map[string]any{
				"sessionId": req.SessionID, "stopReason": "cancelled",
			})
			return map[string]any{"sessionId": req.SessionID, "stopReason": "cancelled"}, nil
		}
		_ = s.conn.Notify("stream/done", map[string]any{
			"sessionId": req.SessionID, "stopReason": "error", "error": err.Error(),
		})
		return nil, err
	}
	return res, nil
}

func (s *server) onCancel(ctx context.Context, params json.RawMessage) (any, error) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &a)
	if a.SessionID == "" {
		a.SessionID = "default"
	}
	return map[string]any{"cancelled": s.conn.Cancel(a.SessionID)}, nil
}

func (s *server) onReset(ctx context.Context, params json.RawMessage) (any, error) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &a)
	if a.SessionID == "" {
		a.SessionID = "default"
	}
	if s.ag != nil {
		s.ag.Reset(a.SessionID)
	}
	return map[string]any{"ok": true}, nil
}

func (s *server) onToolsList(ctx context.Context, _ json.RawMessage) (any, error) {
	type info struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Mutating    bool   `json:"mutating"`
	}
	var out []info
	for _, t := range s.registry.List() {
		out = append(out, info{t.Name, t.Description, t.Mutating})
	}
	return out, nil
}

// onToolsInvoke runs a single tool directly, bypassing the model. The
// extension uses it for explicit user commands, and it makes the core
// exercisable without an API key.
func (s *server) onToolsInvoke(ctx context.Context, params json.RawMessage) (any, error) {
	if s.env == nil {
		return nil, fmt.Errorf("core is not initialized")
	}
	var a struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	t, ok := s.registry.Get(a.Name)
	if !ok {
		return nil, fmt.Errorf("unknown tool %q", a.Name)
	}
	if len(a.Input) == 0 {
		a.Input = json.RawMessage(`{}`)
	}
	// The same gate the agent loop applies — a direct invocation must not be
	// a way around it.
	res, allowed := t.Confirm(ctx, s.env, a.Input)
	if allowed {
		res = t.Run(ctx, s.env, a.Input)
	}
	return map[string]any{"output": res.Output, "isError": res.IsError, "meta": res.Meta}, nil
}

// ---- memory ------------------------------------------------------------

func (s *server) onMemoryStats(ctx context.Context, _ json.RawMessage) (any, error) {
	if s.mem == nil {
		return map[string]any{"enabled": false}, nil
	}
	return s.mem.Stats()
}

func (s *server) onMemoryGraph(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return map[string]any{"nodes": []any{}, "edges": []any{}}, nil
	}
	var a struct {
		Limit int `json:"limit"`
	}
	_ = json.Unmarshal(params, &a)
	return s.mem.GraphView(a.Limit)
}

func (s *server) onMemorySearch(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return []any{}, nil
	}
	var a struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	return s.mem.Search(a.Query, a.Limit, true)
}

func (s *server) onMemoryForget(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return map[string]any{"removed": 0}, nil
	}
	var a struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	n, err := s.mem.Forget(a.Kind, a.Name)
	if err != nil {
		return nil, err
	}
	return map[string]any{"removed": n}, nil
}

func (s *server) onMemoryLessons(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return []any{}, nil
	}
	var a struct {
		Tags  []string `json:"tags"`
		Limit int      `json:"limit"`
	}
	_ = json.Unmarshal(params, &a)
	return s.mem.Lessons(a.Tags, a.Limit)
}

func (s *server) onMemoryLessonUpsert(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return nil, fmt.Errorf("memory is not enabled")
	}
	var a struct {
		Title       string   `json:"title"`
		Description string   `json:"description"`
		Content     []string `json:"content"`
		Tags        []string `json:"tags"`
		Confidence  float64  `json:"confidence"`
		Source      string   `json:"source"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	return s.mem.UpsertLesson(a.Title, a.Description, a.Content, a.Tags, a.Confidence, a.Source)
}

func (s *server) onMemoryLessonDelete(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return nil, fmt.Errorf("memory is not enabled")
	}
	var a struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	if err := s.mem.DeleteLesson(a.ID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *server) onMCPStatus(ctx context.Context, _ json.RawMessage) (any, error) {
	return s.mcpMgr.Status(), nil
}

func (s *server) onBrowserClose(ctx context.Context, _ json.RawMessage) (any, error) {
	if s.brw != nil {
		s.brw.Close()
	}
	return map[string]any{"ok": true}, nil
}
