package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mflores/mfagent/core/internal/llm"
)

func (s *server) onToolsList(ctx context.Context, _ json.RawMessage) (any, error) {
	type info struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Mutating    bool           `json:"mutating"`
		InputSchema map[string]any `json:"inputSchema"`
	}
	var out []info
	for _, t := range s.registry.List() {
		out = append(out, info{t.Name, t.Description, t.Mutating, t.Schema})
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
	res := s.ag.InvokeDirectTool(ctx, llm.Block{Name: a.Name, Input: a.Input}, t)
	return map[string]any{"output": res.Output, "isError": res.IsError, "meta": res.Meta, "usage": res.Usage}, nil
}
