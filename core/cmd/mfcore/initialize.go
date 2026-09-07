package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/mflores/mfagent/core/internal/agent"
	"github.com/mflores/mfagent/core/internal/browser"
	"github.com/mflores/mfagent/core/internal/cognition"
	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/memory"
	"github.com/mflores/mfagent/core/internal/tools"
)

// ---- initialize --------------------------------------------------------

type initResult struct {
	Version   string   `json:"version"`
	Provider  string   `json:"provider"`
	Model     string   `json:"model"`
	Tools     []string `json:"tools"`
	Memory    bool     `json:"memory"`
	Cognition bool     `json:"cognition"`
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
	if err := tools.ApplyTestingProcessEnvironment(cfg.TestingEnvironment); err != nil {
		return nil, err
	}
	if cfg.WorkspaceRoot == "" {
		wd, _ := os.Getwd()
		cfg.WorkspaceRoot = wd
	}
	s.cfg = &cfg

	var warnings []string
	// Operational experience is always local and deterministic. It remains
	// available when optional graph retrieval and embeddings are disabled.
	if s.cognition != nil {
		_ = s.cognition.Close()
		s.cognition = nil
	}
	journal, err := cognition.Open(filepath.Join(cfg.WorkspaceRoot, ".mfagent", "cognition.db"))
	if err != nil {
		warnings = append(warnings, "runtime memory unavailable: "+err.Error())
	} else {
		s.cognition = journal
	}

	s.env = &tools.Env{
		Root:    cfg.WorkspaceRoot,
		Testing: cfg.TestingEnvironment,
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
	tools.RegisterTestingEnvironment(s.registry)
	tools.RegisterApacheRewrite(s.registry)
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

	// Each core owns an isolated browser. Executors and validators can overlap;
	// they must never remove one another's profile locks or change each other's page.
	shotDir := filepath.Join(cfg.WorkspaceRoot, ".mfagent", "screenshots")
	s.brw = browser.New(cfg.BrowserExecutable, cfg.BrowserHeadless, shotDir, "")
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

	visType, visModel, visKey, visBase, visEffort := cfg.ResolveRole(cfg.Vision)
	var vision llm.Provider
	if visModel != "" && visBase != "" || visModel != "" && visType == "anthropic" {
		vision = llm.NewProvider(visType, visBase, visKey, visModel, 4096, visEffort, "")
	}
	tools.RegisterLayout(s.registry, s.brw, vision)

	system := agent.BuildSystemPrompt(agent.PromptInput{
		WorkspaceRoot:         cfg.WorkspaceRoot,
		Languages:             cfg.Languages,
		MemoryEnabled:         s.mem != nil,
		BrowserReady:          true,
		MCPServers:            mcpNames,
		EditorTools:           editorTools,
		ProjectFacts:          agent.LoadProjectInstructions(cfg.WorkspaceRoot),
		Skills:                cfg.SkillsText,
		TestingURL:            cfg.TestingEnvironment.URL,
		HasTestingCredentials: len(cfg.TestingEnvironment.Credentials) > 0,
	})

	s.ag = agent.New(&cfg, provider, s.registry, s.env,
		func(method string, payload any) { _ = s.conn.Notify(method, payload) }, system)
	if s.cognition != nil {
		s.ag.SetCognition(s.cognition)
	}

	var toolNames []string
	for _, t := range s.registry.List() {
		toolNames = append(toolNames, t.Name)
	}

	res := &initResult{
		Version: version, Provider: provType, Model: provModel,
		Tools: toolNames, Memory: s.mem != nil, MCP: mcpNames, Warnings: warnings,
		Cognition: s.cognition != nil,
		Vision:    visModel, EditorTools: editorTools,
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
