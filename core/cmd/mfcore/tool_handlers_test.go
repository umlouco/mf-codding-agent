package main

import (
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/rpc"
	"github.com/mflores/mfagent/core/internal/tools"
)

func initializedToolServer(t *testing.T, inspectOnly bool) *server {
	t.Helper()
	root := t.TempDir()
	s := &server{conn: rpc.NewConn(strings.NewReader(""), io.Discard),
		registry: tools.NewRegistry(), mcpMgr: mcp.NewManager()}
	t.Cleanup(s.shutdown)
	input, err := json.Marshal(map[string]any{"workspaceRoot": root,
		"memoryEnabled": false, "inspectOnly": inspectOnly})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.onInitialize(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	return s
}

func normalizedJSON(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result any
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestToolsListExposesExactRegisteredSchemas(t *testing.T) {
	s := initializedToolServer(t, false)
	reply, err := s.onToolsList(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	listed := normalizedJSON(t, reply).([]any)
	registered := s.registry.List()
	if len(listed) != len(registered) || len(listed) == 0 {
		t.Fatalf("listed %d tools, registered %d", len(listed), len(registered))
	}
	for i, item := range listed {
		got := item.(map[string]any)
		tool := registered[i]
		want := normalizedJSON(t, map[string]any{"name": tool.Name,
			"description": tool.Description, "mutating": tool.Mutating, "inputSchema": tool.Schema})
		if !reflect.DeepEqual(got, want) {
			t.Errorf("tool %s metadata differs: got %#v want %#v", tool.Name, got, want)
		}
		if tool.Schema == nil {
			t.Errorf("initialized tool %s has no input schema", tool.Name)
		}
	}
	// These are independently invocable tools, not shell subcommands. A planner
	// must receive their actual argument names rather than infer them from prose.
	for name, property := range map[string]string{
		"unix": "command", "browser_open": "url", "browser_eval": "expression",
	} {
		tool, ok := s.registry.Get(name)
		if !ok {
			t.Fatalf("missing registered capability %s", name)
		}
		schema := normalizedJSON(t, tool.Schema).(map[string]any)
		if schema["properties"].(map[string]any)[property] == nil {
			t.Errorf("%s schema is missing %s", name, property)
		}
	}
}

func TestToolsInvokePreservesErrorsAndResultShape(t *testing.T) {
	ctx := context.Background()
	if _, err := (&server{}).onToolsInvoke(ctx, nil); err == nil || err.Error() != "core is not initialized" {
		t.Fatalf("uninitialized error changed: %v", err)
	}
	s := initializedToolServer(t, false)
	if _, err := s.onToolsInvoke(ctx, json.RawMessage(`{`)); err == nil {
		t.Fatal("invalid JSON was accepted")
	}
	if _, err := s.onToolsInvoke(ctx, json.RawMessage(`{"name":"absent"}`)); err == nil || err.Error() != `unknown tool "absent"` {
		t.Fatalf("unknown-tool error changed: %v", err)
	}
	for _, isError := range []bool{false, true} {
		usage := llm.Usage{Input: 17, Output: 3, CacheRead: 5}
		s.registry.Add(&tools.Tool{Name: "probe", Run: func(_ context.Context, _ *tools.Env, in json.RawMessage) tools.Result {
			if string(in) != "{}" {
				t.Errorf("omitted input did not default to object: %s", in)
			}
			return tools.Result{Output: "actual output", IsError: isError, Meta: map[string]any{"proof": 7}, Usage: usage}
		}})
		reply, err := s.onToolsInvoke(ctx, json.RawMessage(`{"name":"probe"}`))
		want := map[string]any{"output": "actual output", "isError": isError, "meta": map[string]any{"proof": 7}, "usage": usage}
		if err != nil || !reflect.DeepEqual(reply, want) {
			t.Fatalf("result changed: got %#v err=%v want %#v", reply, err, want)
		}
	}
}

func TestToolsInvokeDoesNotBypassInspectionOrCancellation(t *testing.T) {
	s := initializedToolServer(t, true)
	runs := 0
	for _, tool := range []*tools.Tool{
		{Name: "read_probe"},
		{Name: "write_probe", Mutating: true},
		{Name: "dynamic_probe", MutatesOn: func(json.RawMessage) bool { return false }},
	} {
		tool.Run = func(context.Context, *tools.Env, json.RawMessage) tools.Result {
			runs++
			return tools.Ok("observed")
		}
		s.registry.Add(tool)
		params, _ := json.Marshal(map[string]any{"name": tool.Name})
		reply, err := s.onToolsInvoke(context.Background(), params)
		if err != nil {
			t.Fatal(err)
		}
		got := reply.(map[string]any)
		blocked := tool.Name != "read_probe"
		if got["isError"] != blocked {
			t.Errorf("%s bypassed inspection policy: %#v", tool.Name, got)
		}
		if blocked && !strings.Contains(got["output"].(string), "inspection-only") {
			t.Errorf("missing policy explanation: %#v", got)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reply, err := s.onToolsInvoke(ctx, json.RawMessage(`{"name":"read_probe"}`))
	if err != nil || reply.(map[string]any)["isError"] != true || runs != 1 {
		t.Fatalf("cancelled invocation executed: reply=%#v err=%v runs=%d", reply, err, runs)
	}
}
