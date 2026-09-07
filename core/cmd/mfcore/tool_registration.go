package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/tools"
)

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
