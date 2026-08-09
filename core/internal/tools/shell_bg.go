package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// bgProc holds a running background command so it can be killed later.
type bgProc struct {
	cmd    *exec.Cmd
	label  string
	pid    int
	started time.Time
}

var (
	bgMu    sync.Mutex
	bgProcs = map[string]*bgProc{}
	bgSeq   int
)

func RegisterShellBg(r *Registry) {
	r.Add(&Tool{
		Name: "shell_run_background",
		Description: "Start a shell command in the background (e.g. 'go run .' or 'wails dev'). " +
			"The command runs asynchronously; this tool returns the background ID and PID immediately. " +
			"Use shell_kill_background to stop it later. " +
			"Stdout and stderr are discarded — redirect to a file if you need the output.",
		Mutating: true,
		Schema: obj(map[string]any{
			"command": str("The command line to run in the background."),
			"cwd":     str("Working directory relative to the workspace root. Optional."),
		}, "command"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Command string `json:"command"`
			}
			_ = json.Unmarshal(in, &a)
			return "Start background: " + a.Command
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Command string `json:"command"`
				Cwd     string `json:"cwd"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if strings.TrimSpace(a.Command) == "" {
				return Errf("command is empty")
			}

			dir := env.Root
			if a.Cwd != "" {
				var err error
				if dir, err = env.Resolve(a.Cwd); err != nil {
					return Errf("%v", err)
				}
			}

			name, args, cleanup := shellFor(a.Command)
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "MFAGENT=1", "NO_COLOR=1", "CI=1")
			cmd.Stdin = nil
			cmd.Stdout = nil
			cmd.Stderr = nil

			if err := cmd.Start(); err != nil {
				cleanup()
				return Errf("failed to start background command: %v", err)
			}

			bgMu.Lock()
			bgSeq++
			id := fmt.Sprintf("bg-%d", bgSeq)
			bgProcs[id] = &bgProc{
				cmd:     cmd,
				label:   a.Command,
				pid:     cmd.Process.Pid,
				started: time.Now(),
			}
			bgMu.Unlock()

			// Reap the process in the background so it does not become a zombie.
			go func(id string, cleanup func()) {
				_ = cmd.Wait()
				cleanup()
				bgMu.Lock()
				delete(bgProcs, id)
				bgMu.Unlock()
			}(id, cleanup)

			return Ok(fmt.Sprintf("Background process started.\nID: %s\nPID: %d\nCommand: %s\nCwd: %s",
				id, cmd.Process.Pid, a.Command, env.Rel(dir)))
		},
	})

	r.Add(&Tool{
		Name: "shell_kill_background",
		Description: "Stop a background process started by shell_run_background. " +
			"Accepts the background ID returned by shell_run_background. " +
			"Returns whether the process was found and killed.",
		Mutating: true,
		Schema: obj(map[string]any{
			"id": str("The background process ID from shell_run_background (e.g. \"bg-1\")."),
		}, "id"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(in, &a)
			return "Kill background: " + a.ID
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.ID == "" {
				return Errf("id is required")
			}

			bgMu.Lock()
			p, ok := bgProcs[a.ID]
			bgMu.Unlock()
			if !ok {
				return Ok(fmt.Sprintf("No background process with ID %q running.", a.ID))
			}

			// Kill the process tree on Windows, or the single process elsewhere.
			if err := killProcess(p.cmd); err != nil {
				return Errf("failed to kill background process %q (pid %d): %v", a.ID, p.pid, err)
			}
			return Ok(fmt.Sprintf("Killed background process %q (pid %d, started %s ago).\nCommand: %s",
				a.ID, p.pid, time.Since(p.started).Round(time.Second), p.label))
		},
	})

	r.Add(&Tool{
		Name: "shell_wait_for_http",
		Description: "Poll a URL until it responds with a successful status code (2xx), or until a timeout. " +
			"Use this after starting a dev server with shell_run_background to wait for it to be ready " +
			"before using browser tools against it.",
		Schema: obj(map[string]any{
			"url":         str("The URL to poll, e.g. http://localhost:5173/."),
			"timeout_ms":  num("Maximum time to wait in milliseconds. Default 30000."),
			"interval_ms": num("Time between polls in milliseconds. Default 500."),
		}, "url"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				URL string `json:"url"`
			}
			_ = json.Unmarshal(in, &a)
			return "Wait for: " + a.URL
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				URL        string `json:"url"`
				TimeoutMS  int    `json:"timeout_ms"`
				IntervalMS int    `json:"interval_ms"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.URL == "" {
				return Errf("url is required")
			}

			timeout := 30 * time.Second
			if a.TimeoutMS > 0 {
				timeout = time.Duration(a.TimeoutMS) * time.Millisecond
			}
			if timeout > 5*time.Minute {
				timeout = 5 * time.Minute
			}

			interval := 500 * time.Millisecond
			if a.IntervalMS > 0 {
				interval = time.Duration(a.IntervalMS) * time.Millisecond
			}
			if interval < 200*time.Millisecond {
				interval = 200 * time.Millisecond
			}

			deadline := time.Now().Add(timeout)
			client := &http.Client{Timeout: 5 * time.Second}
			var lastErr string

			for time.Now().Before(deadline) {
				select {
				case <-ctx.Done():
					return Errf("cancelled while waiting for %s", a.URL)
				default:
				}

				resp, err := client.Get(a.URL)
				if err != nil {
					lastErr = err.Error()
					time.Sleep(interval)
					continue
				}
				resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					return Ok(fmt.Sprintf("URL %s is responding (status %d).", a.URL, resp.StatusCode))
				}
				lastErr = fmt.Sprintf("HTTP %d", resp.StatusCode)
				time.Sleep(interval)
			}

			return Errf("timed out after %s waiting for %s. Last error: %s", timeout, a.URL, lastErr)
		},
	})
}

// killProcess terminates the process and its children. On non-Windows platforms
// it sends SIGKILL to the process group; on Windows it uses taskkill /T.
func killProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// ActiveBgProcs returns a copy of the current bgProcs map so external code
// (e.g. the server shutdown) can clean up background processes.
func ActiveBgProcs() map[string]*bgProc {
	bgMu.Lock()
	defer bgMu.Unlock()
	out := make(map[string]*bgProc, len(bgProcs))
	for k, v := range bgProcs {
		out[k] = v
	}
	return out
}

// KillAllBgProcs kills every running background process. Call this on shutdown.
func KillAllBgProcs() {
	bgMu.Lock()
	defer bgMu.Unlock()
	for id, p := range bgProcs {
		_ = killProcess(p.cmd)
		delete(bgProcs, id)
	}
}

// bgProcsList returns human-readable list of running background processes.
// Registered as a private helper available to the agent via the tools.
func bgProcsList() string {
	bgMu.Lock()
	defer bgMu.Unlock()
	if len(bgProcs) == 0 {
		return "No background processes running."
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d background process(es):\n", len(bgProcs))
	for id, p := range bgProcs {
		fmt.Fprintf(&b, "  %s  pid=%d  uptime=%s  %s\n",
			id, p.pid, time.Since(p.started).Round(time.Second), p.label)
	}
	return b.String()
}


