package tools

import (
	"context"
	"encoding/json"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func listening(port int) bool {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func waitFor(cond func() bool, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return cond()
}

// A server started by shell_run_background — directly or inside run_script —
// must outlive the call's context, and killing it must reach the real server
// process, not only the shell wrapper. Both failures were observed on Windows:
// the batch cancelled its context and the server vanished, and Process.Kill left
// `python -m http.server` orphaned and holding its port.
func TestBackgroundServerOutlivesCallAndDiesWithTree(t *testing.T) {
	python, err := exec.LookPath("python")
	if err != nil {
		if python, err = exec.LookPath("python3"); err != nil {
			t.Skip("python is not available for a real child-process server")
		}
	}
	port := freePort(t)
	r := NewRegistry()
	RegisterShellBg(r)
	RegisterBatch(r)
	env := &Env{Root: t.TempDir()}
	command := strconv.Quote(python) + " -m http.server " + strconv.Itoa(port) + " --bind 127.0.0.1"
	if runtime.GOOS == "windows" {
		command = "& " + command
	}
	input, _ := json.Marshal(map[string]any{"steps": []map[string]any{{
		"tool": "shell_run_background", "args": map[string]any{"command": command},
	}}})

	ctx, cancel := context.WithCancel(context.Background())
	tool, _ := r.Get("run_script")
	res := tool.Run(ctx, env, input)
	cancel()
	if res.IsError {
		t.Fatalf("batch failed: %s", res.Output)
	}
	t.Cleanup(KillAllBgProcs)
	if !waitFor(func() bool { return listening(port) }, 15*time.Second) {
		t.Fatalf("background server did not survive its batch returning: %s", res.Output)
	}

	id := regexp.MustCompile(`ID: (bg-\d+)`).FindStringSubmatch(res.Output)
	if id == nil {
		t.Fatalf("no background id in %s", res.Output)
	}
	kill, _ := r.Get("shell_kill_background")
	if out := kill.Run(context.Background(), env, json.RawMessage(`{"id":"`+id[1]+`"}`)); out.IsError {
		t.Fatal(out.Output)
	}
	if !waitFor(func() bool { return !listening(port) }, 10*time.Second) {
		t.Fatal("killing the background process left the server child listening")
	}
}
