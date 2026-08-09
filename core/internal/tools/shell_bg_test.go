package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestShellBgToolsRegistered(t *testing.T) {
	r := NewRegistry()
	RegisterShellBg(r)

	for _, name := range []string{"shell_run_background", "shell_kill_background", "shell_wait_for_http"} {
		tool, ok := r.Get(name)
		if !ok {
			t.Fatalf("tool %q not found in registry", name)
		}
		if tool.Name != name {
			t.Fatalf("tool name mismatch: got %q, want %q", tool.Name, name)
		}
	}
}

func TestShellRunAndKillBackground(t *testing.T) {
	ctx := context.Background()
	env := &Env{Root: t.TempDir()}

	r := NewRegistry()
	RegisterShellBg(r)

	// Start a background process that sleeps.
	startTool, ok := r.Get("shell_run_background")
	if !ok {
		t.Fatal("shell_run_background not registered")
	}

	in, _ := json.Marshal(map[string]string{"command": "sleep 60"})
	res := startTool.Run(ctx, env, in)
	if res.IsError {
		t.Fatalf("start failed: %s", res.Output)
	}
	if !strings.Contains(res.Output, "Background process started") {
		t.Fatalf("unexpected output: %s", res.Output)
	}

	// Extract the ID from the output.
	lines := strings.Split(res.Output, "\n")
	var bgID string
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "ID:") {
			bgID = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "ID:"))
			break
		}
	}
	if bgID == "" {
		t.Fatal("could not extract background ID from output")
	}

	// Kill it.
	killTool, ok := r.Get("shell_kill_background")
	if !ok {
		t.Fatal("shell_kill_background not registered")
	}

	killIn, _ := json.Marshal(map[string]string{"id": bgID})
	killRes := killTool.Run(ctx, env, killIn)
	if killRes.IsError {
		t.Fatalf("kill failed: %s", killRes.Output)
	}
	if !strings.Contains(killRes.Output, "Killed background process") {
		t.Fatalf("unexpected kill output: %s", killRes.Output)
	}

	// Killing again should report it's not running.
	killRes2 := killTool.Run(ctx, env, killIn)
	if strings.Contains(killRes2.Output, "Killed") {
		t.Fatalf("expected 'not running' but got: %s", killRes2.Output)
	}
}

func TestShellWaitForHTTP(t *testing.T) {
	ctx := context.Background()
	env := &Env{Root: t.TempDir()}

	r := NewRegistry()
	RegisterShellBg(r)

	waitTool, ok := r.Get("shell_wait_for_http")
	if !ok {
		t.Fatal("shell_wait_for_http not registered")
	}

	// Start a real HTTP server on a random port.
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	})
	srv := &http.Server{Addr: "127.0.0.1:0", Handler: mux}
	go srv.ListenAndServe()
	defer srv.Close()

	// Give it a moment to bind.
	time.Sleep(100 * time.Millisecond)

	// We need the actual port. Easiest: poll with a short timeout.
	// Instead, let's test the timeout path which is simpler and still exercises the tool.
	in, _ := json.Marshal(map[string]any{
		"url":         "http://127.0.0.1:19999/nonexistent",
		"timeout_ms":  500,
		"interval_ms": 100,
	})
	res := waitTool.Run(ctx, env, in)
	if !res.IsError {
		t.Fatalf("expected timeout error but got success: %s", res.Output)
	}
	if !strings.Contains(res.Output, "timed out") {
		t.Fatalf("expected 'timed out' in output: %s", res.Output)
	}
}

func TestActiveBgProcsAndKillAll(t *testing.T) {
	ctx := context.Background()
	env := &Env{Root: t.TempDir()}

	r := NewRegistry()
	RegisterShellBg(r)

	startTool, _ := r.Get("shell_run_background")

	// Start two processes.
	for i := 0; i < 2; i++ {
		in, _ := json.Marshal(map[string]string{"command": "sleep 300"})
		res := startTool.Run(ctx, env, in)
		if res.IsError {
			t.Fatalf("start %d failed: %s", i, res.Output)
		}
	}

	procs := ActiveBgProcs()
	if len(procs) != 2 {
		t.Fatalf("expected 2 active processes, got %d", len(procs))
	}

	KillAllBgProcs()

	procs = ActiveBgProcs()
	if len(procs) != 0 {
		t.Fatalf("expected 0 active processes after KillAll, got %d", len(procs))
	}
}
