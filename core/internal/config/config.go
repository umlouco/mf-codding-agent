package config

import (
	"os"
	"path/filepath"
)

// ProviderConfig describes a single LLM provider entry.
type ProviderConfig struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Type      string   `json:"type"`
	APIKey    string   `json:"apiKey"`
	BaseURL   string   `json:"baseURL"`
	Models    []string `json:"models"`
	Reasoning bool     `json:"reasoning"`
	Enabled   bool     `json:"enabled"`
}

// RoleConfig picks a provider + model for a specific role.
type RoleConfig struct {
	ProviderID string `json:"providerId"`
	Model      string `json:"model"`
	// Effort is a reasoning-effort hint ("low"/"medium"/"high"/"max"/…), or ""
	// to use the provider's own default. Only the Coding role's value is ever
	// consumed today: the core binds one provider per process, and the queue
	// spins up a fresh process per role with that role rewritten onto Coding
	// (see the editor's queue/agents.ts), so this one field covers every role.
	Effort string `json:"effort"`
}

func (r RoleConfig) IsZero() bool { return r.ProviderID == "" && r.Model == "" }

type MCPServer struct {
	Name    string            `json:"name"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Enabled *bool             `json:"enabled,omitempty"`
	// Source says where the editor found this definition — "user" for VS
	// Code's own mcp.json, "settings" for the mfagent.mcpServers setting,
	// "store" for the MF Agent settings page — so a connection failure can
	// point at the place to fix it. See DiscoveredMcpServer in src/mcp.ts.
	Source string `json:"source,omitempty"`
}

func (s MCPServer) IsEnabled() bool { return s.Enabled == nil || *s.Enabled }

// EditorToolDef is one tool VS Code's language-model API offers (`vscode.lm.tools`):
// a tool another extension registered, or one of an MCP server the editor runs
// itself. The core cannot see that API, so the extension sends the definitions
// here and answers each call over JSON-RPC (`lm/invokeTool`) — see
// registerEditorTools in cmd/mfcore and src/mcpBridge.ts.
type EditorToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Tags        []string       `json:"tags"`
}

type Config struct {
	WorkspaceRoot string `json:"workspaceRoot"`

	Providers []ProviderConfig `json:"providers"`

	// Role assignments. Each picks a provider id + model.
	Coding    RoleConfig `json:"coding"`
	Vision    RoleConfig `json:"vision"`
	Embedding RoleConfig `json:"embedding"`

	MemoryEnabled bool   `json:"memoryEnabled"`
	MemoryPath    string `json:"memoryPath"`

	// DisableTools creates a conclusion-only turn. Queue supervisors use it so
	// verification commands, browser runs, and code inspection stay executor work.
	DisableTools bool `json:"disableTools"`

	// Tool-calling rounds allowed in one turn. Zero means the built-in default,
	// and a negative number means no round ceiling at all. The editor raises it
	// for unattended queue workers, which have nobody to tell them to continue,
	// and removes it entirely where a supervisor decides when the turn ends.
	MaxIterations int `json:"maxIterations"`

	// Context tokens one round may carry before the turn is stopped and asked
	// for a handoff report. Zero means the built-in default; negative disables
	// the ceiling.
	//
	// This is the backstop for a turn that has no round ceiling. It is not a
	// budget and not a judgement about the work: the conversation grows by every
	// tool result, so a model that keeps calling tools without converging walks
	// into the provider's own context limit and dies there, taking the account
	// of what it did with it. Stopping just short of that turns a lost turn into
	// a reported one.
	MaxContextTokens int64 `json:"maxContextTokens"`

	// Seconds a model reply may go without delivering a single byte before the
	// connection is treated as dropped. Zero means the built-in default.
	//
	// This is not a budget for the reply. A local model may spend hours on one
	// answer and that is legitimate work; what is never legitimate is a socket
	// that has stopped delivering. Every byte read resets the window, so a slow
	// model stays distinguishable from a dead one without capping either.
	LLMIdleSeconds int `json:"llmIdleSeconds"`

	// How often a turn writes a timestamped activity record while it waits on
	// the model. Zero means the built-in default.
	//
	// This is what makes progress observable without imposing a deadline: an
	// agent that is alive keeps writing, so silence rather than elapsed time is
	// the evidence that something has gone wrong.
	ActivitySeconds int `json:"activitySeconds"`

	MCPServers []MCPServer `json:"mcpServers"`

	// EditorTools are the `vscode.lm.tools` this workspace has switched on for
	// its agents, registered as `editor__<name>` and run by the editor on the
	// core's behalf. Empty in any process with no editor behind it.
	EditorTools []EditorToolDef `json:"editorTools"`

	// SkillsText is pre-formatted skill content, chosen by the editor from
	// whichever skill groups the active workspace's task queue has switched
	// on (see AgentSettings.skillGroups and TaskQueue.enabledSkillGroups on
	// the TypeScript side). Spliced into the system prompt the same way
	// ProjectFacts is — see agent.PromptInput.Skills.
	SkillsText string `json:"skillsText"`

	BrowserExecutable string `json:"browserExecutable"`
	BrowserHeadless   bool   `json:"browserHeadless"`

	// EditorTerminal is set by the extension when it can run run_shell in a
	// real VS Code terminal — which needs both a recent enough VS Code and the
	// user's shell integration actually working. The extension is the only
	// side that can know that, so it decides and the core takes its word for
	// it, falling back to spawning a shell itself when this is false.
	EditorTerminal bool `json:"editorTerminal"`

	Languages []string `json:"languages"`
}

// ResolveProvider looks up a ProviderConfig by id. Returns nil if not found or
// not enabled.
func (c *Config) ResolveProvider(id string) *ProviderConfig {
	for i := range c.Providers {
		if c.Providers[i].ID == id && c.Providers[i].Enabled {
			return &c.Providers[i]
		}
	}
	return nil
}

// ResolveEmbedding returns the (model, apiKey, baseURL) for the embedding role
// without any fallback.
//
// Every other role can borrow the coding model and still do something useful.
// Embedding cannot: a chat endpoint has no /embeddings route, so inheriting one
// turns "no embedding model configured" into a stream of 404s from a URL the
// user never chose. An unset embedding role must stay unset.
func (c *Config) ResolveEmbedding() (model, apiKey, baseURL string) {
	if c.Embedding.IsZero() {
		return "", "", ""
	}
	p := c.ResolveProvider(c.Embedding.ProviderID)
	if p == nil {
		return "", "", ""
	}
	model = c.Embedding.Model
	if model == "" && len(p.Models) > 0 {
		model = p.Models[0]
	}
	return model, c.resolveAPIKey(p), c.resolveBaseURL(p)
}

// ResolveRole returns the effective (provider, model, apiKey, baseURL,
// effort) for a role. Falls back to the Coding role if the given role is
// unset, then falls back to the first enabled provider.
func (c *Config) ResolveRole(role RoleConfig) (string, string, string, string, string) {
	rc := role
	if rc.IsZero() {
		rc = c.Coding
	}
	if rc.IsZero() && len(c.Providers) > 0 {
		for i := range c.Providers {
			if c.Providers[i].Enabled {
				if len(c.Providers[i].Models) > 0 {
					return c.Providers[i].Type, c.Providers[i].Models[0],
						c.resolveAPIKey(&c.Providers[i]),
						c.resolveBaseURL(&c.Providers[i]), rc.Effort
				}
				return c.Providers[i].Type, "",
					c.resolveAPIKey(&c.Providers[i]),
					c.resolveBaseURL(&c.Providers[i]), rc.Effort
			}
		}
		return "openai-compatible", "", "", "", ""
	}

	p := c.ResolveProvider(rc.ProviderID)
	if p == nil {
		return "openai-compatible", rc.Model, os.Getenv("ANTHROPIC_API_KEY"), "", rc.Effort
	}

	model := rc.Model
	if model == "" && len(p.Models) > 0 {
		model = p.Models[0]
	}
	return p.Type, model, c.resolveAPIKey(p), c.resolveBaseURL(p), rc.Effort
}

func (c *Config) resolveAPIKey(p *ProviderConfig) string {
	if p.APIKey != "" {
		return p.APIKey
	}
	if k := os.Getenv("ANTHROPIC_API_KEY"); k != "" {
		return k
	}
	return os.Getenv("OPENAI_API_KEY")
}

func (c *Config) resolveBaseURL(p *ProviderConfig) string {
	return p.BaseURL
}

func (c *Config) ApplyDefaults() {
	if c.MemoryPath == "" && c.WorkspaceRoot != "" {
		c.MemoryPath = filepath.Join(c.WorkspaceRoot, ".mfagent", "memory.db")
	}
	if len(c.Languages) == 0 {
		c.Languages = []string{"PHP", "JavaScript", "TypeScript", "Go", "Delphi/Object Pascal"}
	}
	// Enabled defaults to true for any provider that doesn't set it explicitly.
	// We can't distinguish "explicitly false" from "missing" in JSON, so we
	// only treat the first element specially — if it has no models but IS
	// enabled, it's probably an incomplete config from the default.
}
