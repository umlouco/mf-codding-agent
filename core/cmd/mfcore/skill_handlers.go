package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/mflores/mfagent/core/internal/wordpress"
)

// The same deterministic selector serves native and external CLI providers.
func (s *server) onSkillsContext(ctx context.Context, input json.RawMessage) (any, error) {
	if s.env == nil {
		return nil, fmt.Errorf("core is not initialized")
	}
	var args struct {
		Task   string   `json:"task"`
		Paths  []string `json:"paths"`
		Budget int      `json:"budget"`
	}
	if err := json.Unmarshal(input, &args); err != nil {
		return nil, err
	}
	if args.Budget <= 0 {
		args.Budget = wordpress.MaxAutoBytes
	}
	pack, _ := wordpress.Load()
	return wordpress.Select(pack, s.env.Root, args.Task, args.Paths, args.Budget), nil
}
