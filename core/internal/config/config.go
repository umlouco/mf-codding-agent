package config

import (
	"os"
	"path/filepath"
	"strings"
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
}

func (s MCPServer) IsEnabled() bool { return s.Enabled == nil || *s.Enabled }

type Config struct {
	WorkspaceRoot string `json:"workspaceRoot"`

	Providers []ProviderConfig `json:"providers"`

	// Role assignments. Each picks a provider id + model.
	Coding    RoleConfig `json:"coding"`
	Vision    RoleConfig `json:"vision"`
	Embedding RoleConfig `json:"embedding"`

	MemoryEnabled   bool   `json:"memoryEnabled"`
	MemoryPath      string `json:"memoryPath"`

	AutoApprove []string `json:"autoApprove"`

	// Tool-calling rounds allowed in one turn. Zero means the built-in default.
	// The editor raises it for unattended queue workers, which have nobody to
	// tell them to continue, and raises it again on each retry.
	MaxIterations int `json:"maxIterations"`

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

	BrowserExecutable string `json:"browserExecutable"`
	BrowserHeadless   bool   `json:"browserHeadless"`

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

// ResolveRole returns the effective (provider, model, apiKey, baseURL) for a
// role. Falls back to the Coding role if the given role is unset, then falls
// back to the first enabled provider.
func (c *Config) ResolveRole(role RoleConfig) (string, string, string, string) {
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
						c.resolveBaseURL(&c.Providers[i])
				}
				return c.Providers[i].Type, "",
					c.resolveAPIKey(&c.Providers[i]),
					c.resolveBaseURL(&c.Providers[i])
			}
		}
		return "openai-compatible", "", "", ""
	}

	p := c.ResolveProvider(rc.ProviderID)
	if p == nil {
		return "openai-compatible", rc.Model, os.Getenv("ANTHROPIC_API_KEY"), ""
	}

	model := rc.Model
	if model == "" && len(p.Models) > 0 {
		model = p.Models[0]
	}
	return p.Type, model, c.resolveAPIKey(p), c.resolveBaseURL(p)
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

func (c *Config) IsAutoApproved(tool string) bool {
	for _, t := range c.AutoApprove {
		if strings.EqualFold(t, tool) || t == "*" {
			return true
		}
	}
	return false
}
