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
	// EditorTools counts the VS Code language-model tools registered for this
	// process — see registerEditorTools.
	EditorTools int      `json:"editorTools,omitempty"`
	Warnings    []string `json:"warnings,omitempty"`
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
		Emit: func(kind string, payload any) {
			_ = s.conn.Notify("stream/event", map[string]any{"kind": kind, "payload": payload})
		},
		FileChanged: func(path string) {
			_ = s.conn.Notify("file/changed", map[string]any{"path": path})
		},
		EditorWrite: s.editorWrite,
		EditorEdit:  s.editorEdit,
	}
	if cfg.EditorTerminal {
		s.env.EditorTerminal = s.editorTerminal
	}

	tools.RegisterFS(s.registry)
	tools.RegisterSearch(s.registry)
	tools.RegisterPosix(s.registry)
	tools.RegisterShell(s.registry)
	tools.RegisterShellBg(s.registry)
	// Unconditional: whether the project can actually run Playwright is
	// decided per call against the workspace, and playwright_status exists
	// precisely to explain when it cannot.
	tools.RegisterPlaywright(s.registry)

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

	// Browser control. The profile dir is persistent and workspace-scoped so a
	// login survives across the throwaway cores the queue spawns per task —
	// authenticate once, and every later task opens already signed in. The
	// queue runs lockstep, so only one core drives this profile at a time.
	shotDir := filepath.Join(cfg.WorkspaceRoot, ".mfagent", "screenshots")
	profileDir := filepath.Join(cfg.WorkspaceRoot, ".mfagent", "browser-profile")
	s.brw = browser.New(cfg.BrowserExecutable, cfg.BrowserHeadless, shotDir, profileDir)
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
				warnings = append(warnings, fmt.Sprintf("MCP server %q%s: %v",
					spec.Name, describeSource(spec.Source), err))
				return
			}
			mcpNames = append(mcpNames, spec.Name)
			s.registerMCPTools(spec.Name, client)
		}(spec)
	}
	wg.Wait()

	// Tools the editor offers through vscode.lm, run by the editor on request.
	editorTools := s.registerEditorTools(cfg.EditorTools)

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
		EditorTools:   editorTools,
		ProjectFacts:  agent.LoadProjectInstructions(cfg.WorkspaceRoot),
		Skills:        cfg.SkillsText,
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
		Vision: visModel, EditorTools: editorTools,
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
			Mutating:    true, // an external server's side effects are unknown
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

// registerEditorTools exposes the `vscode.lm.tools` the extension chose to
// share (config.EditorTools) as `editor__<name>` tools. Each call goes back to
// the extension as an `lm/invokeTool` request, the way file writes and
// terminal commands already do; VS Code validates the input against the
// tool's own schema and runs it — an MCP server the editor manages, or code in
// another extension. Registered after the MCP tools so a name that collides
// with a core tool is the one skipped, never the core's own.
//
// Every editor tool counts as mutating: what one does is the editor's
// business, and an unknown side effect is sequenced, not raced.
func (s *server) registerEditorTools(defs []config.EditorToolDef) int {
	n := 0
	for _, d := range defs {
		if d.Name == "" {
			continue
		}
		name := "editor__" + sanitize(d.Name)
		if _, taken := s.registry.Get(name); taken {
			continue
		}
		original := d.Name
		desc := d.Description
		if desc == "" {
			desc = "Tool " + original + " provided by VS Code."
		}
		schema := d.InputSchema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		s.registry.Add(&tools.Tool{
			Name:        name,
			Description: desc + " (a VS Code language-model tool; the editor runs it)",
			Schema:      schema,
			Mutating:    true,
			Summarize: func(json.RawMessage) string {
				return "Call " + original + " through VS Code"
			},
			Run: func(ctx context.Context, env *tools.Env, in json.RawMessage) tools.Result {
				if len(in) == 0 {
					in = json.RawMessage(`{}`)
				}
				var reply struct {
					Output  string `json:"output"`
					IsError bool   `json:"isError"`
				}
				if err := s.conn.Call(ctx, "lm/invokeTool", map[string]any{
					"name": original, "input": in,
				}, &reply); err != nil {
					return tools.Errf("editor tool %s failed: %v", original, err)
				}
				return tools.Result{Output: reply.Output, IsError: reply.IsError}
			},
		})
		n++
	}
	return n
}

// describeSource names where a server's definition came from, so a failed
// connection points at the file or page to fix rather than at the server.
func describeSource(source string) string {
	switch source {
	case "user":
		return " (from your VS Code user mcp.json)"
	case "settings":
		return " (from the mfagent.mcpServers setting)"
	case "store":
		return " (from the MF Agent settings page)"
	default:
		return ""
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

// ---- editor-side file writes --------------------------------------------
//
// These hand the actual mutation to the extension instead of touching the
// file directly — see Env.EditorWrite / Env.EditorEdit and src/editorFs.ts.
// The point is not speed, it is correctness: the extension applies the
// change through vscode.workspace.applyEdit against whatever is actually
// live for that file (an open, possibly unsaved buffer, or disk if nothing
// has it open), so an edit can never silently overwrite work the user has
// not saved yet, and it participates in VS Code's own undo stack. It always
// ends with the document saved, so every other tool — which still reads and
// writes the workspace directly — keeps seeing disk as the single source of
// truth.

func (s *server) editorWrite(ctx context.Context, path, content string) error {
	var reply struct {
		OK bool `json:"ok"`
	}
	return s.conn.Call(ctx, "fs/write", map[string]any{
		"path": path, "content": content,
	}, &reply)
}

// editorTerminal asks the extension to run a command in a real VS Code
// terminal — see Env.EditorTerminal and src/editorTerminal.ts. It is wired in
// only when the extension announced that it has shell integration to offer, so
// a nil hook and a failed call mean different things: nil is "no terminal
// available, spawn it yourself", an error is "the terminal tried and could not".
func (s *server) editorTerminal(ctx context.Context, cwd, command string, timeoutMS int) (tools.TerminalRun, error) {
	var reply struct {
		Output   string `json:"output"`
		ExitCode *int   `json:"exitCode"`
		TimedOut bool   `json:"timedOut"`
	}
	if err := s.conn.Call(ctx, "shell/exec", map[string]any{
		"cwd": cwd, "command": command, "timeoutMs": timeoutMS,
	}, &reply); err != nil {
		return tools.TerminalRun{}, err
	}
	return tools.TerminalRun{
		Output: reply.Output, ExitCode: reply.ExitCode, TimedOut: reply.TimedOut,
	}, nil
}

func (s *server) editorEdit(ctx context.Context, path string, edits []tools.EditOp) (int, error) {
	type editParam struct {
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all"`
	}
	params := make([]editParam, len(edits))
	for i, e := range edits {
		params[i] = editParam{OldString: e.OldString, NewString: e.NewString, ReplaceAll: e.ReplaceAll}
	}
	var reply struct {
		Replacements int `json:"replacements"`
	}
	if err := s.conn.Call(ctx, "fs/edit", map[string]any{
		"path": path, "edits": params,
	}, &reply); err != nil {
		return 0, err
	}
	return reply.Replacements, nil
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
	res := t.Run(ctx, s.env, a.Input)
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
