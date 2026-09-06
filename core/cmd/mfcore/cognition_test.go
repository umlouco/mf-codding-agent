package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/cognition"
	"github.com/mflores/mfagent/core/internal/mcp"
	"github.com/mflores/mfagent/core/internal/rpc"
	"github.com/mflores/mfagent/core/internal/tools"
)

func TestRuntimeMemoryInitializesIndependentlyAndDegradesWithoutBlockingTools(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		name := "without_graph_memory"
		if unavailable {
			name = "unwritable_database"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if unavailable {
				// A directory at the intended database path makes opening the
				// journal fail on every platform, even when tests run as root.
				if err := os.MkdirAll(filepath.Join(root, ".mfagent", "cognition.db"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			s := &server{conn: rpc.NewConn(strings.NewReader(""), io.Discard), registry: tools.NewRegistry(), mcpMgr: mcp.NewManager()}
			t.Cleanup(s.shutdown)
			input, err := json.Marshal(map[string]any{"workspaceRoot": root, "memoryEnabled": false})
			if err != nil {
				t.Fatal(err)
			}
			reply, err := s.onInitialize(context.Background(), input)
			if err != nil {
				t.Fatalf("initialize failed because of runtime memory: %v", err)
			}
			init := reply.(*initResult)
			if init.Memory || init.Cognition == unavailable || (s.cognition == nil) != unavailable {
				t.Fatalf("initialized graph=%v cognition=%v store=%v", init.Memory, init.Cognition, s.cognition)
			}
			if unavailable && !strings.Contains(strings.Join(init.Warnings, "\n"), "runtime memory unavailable") {
				t.Errorf("missing persistence warning: %v", init.Warnings)
			}
			var called bool
			worker := cognition.Scope{WorkID: "existing-worker", Observer: "executor", RunID: "existing-attempt"}
			var before cognition.Snapshot
			if s.cognition != nil {
				before, err = s.cognition.StartRun(worker)
				if err != nil {
					t.Fatal(err)
				}
			}
			s.registry.Add(&tools.Tool{Name: "probe", Mutating: true, Run: func(context.Context, *tools.Env, json.RawMessage) tools.Result {
				called = true
				return tools.Ok("observed")
			}})
			result, err := s.onToolsInvoke(context.Background(), json.RawMessage(`{"name":"probe","input":{}}`))
			if err != nil || !called || result.(map[string]any)["output"] != "observed" {
				t.Fatalf("tool execution result=%+v err=%v called=%v", result, err, called)
			}
			if s.cognition != nil {
				after, err := s.cognition.View(worker)
				if err != nil || after.Epoch <= before.Epoch {
					t.Fatalf("direct tool mutation failed to invalidate other worker evidence: before=%+v after=%+v err=%v", before, after, err)
				}
			}
		})
	}
}
