package tools

import (
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRunShellBoundsInheritedOutputPipes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX background shell reproduction")
	}
	r := NewRegistry()
	RegisterShell(r)
	tool, _ := r.Get("run_shell")
	// The child outlives the shell and holds both output descriptors open.
	// It terminates itself so even a failing regression leaves no server behind.
	in := json.RawMessage(`{"command":"sleep 5 & echo launched", "timeout_ms":10000}`)
	start := time.Now()
	result := tool.Run(context.Background(), &Env{Root: t.TempDir()}, in)
	if time.Since(start) > 4*time.Second {
		t.Fatalf("waited for background child: %s", result.Output)
	}
	if !result.IsError || !strings.Contains(result.Output, "shell_run_background") || !strings.Contains(result.Output, "launched") {
		t.Fatalf("expected actionable pipe error with captured output: %+v", result)
	}
}

func TestRunShellReportsTimeoutAndCancellation(t *testing.T) {
	command := "sleep 5"
	if runtime.GOOS == "windows" {
		command = "Start-Sleep -Seconds 5"
	}
	for _, cancelEarly := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "cancel"}[cancelEarly], func(t *testing.T) {
			r := NewRegistry()
			RegisterShell(r)
			tool, _ := r.Get("run_shell")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			want := "timed out"
			if cancelEarly {
				cancel()
				want = "cancelled"
			}
			in, _ := json.Marshal(map[string]any{"command": command, "timeout_ms": 100})
			start := time.Now()
			result := tool.Run(ctx, &Env{Root: t.TempDir()}, in)
			if time.Since(start) > 4*time.Second || !result.IsError || !strings.Contains(result.Output, want) {
				t.Fatalf("expected prompt %s result: %+v", want, result)
			}
		})
	}
}
