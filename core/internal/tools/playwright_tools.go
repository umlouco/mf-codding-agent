package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/mflores/mfagent/core/internal/playwright"
)

func RegisterPlaywright(r *Registry) {
	r.Add(&Tool{
		Name: "playwright_status",
		Description: "Report whether this project can run Playwright: config file, " +
			"@playwright/test version, installed CLI, and Node availability on the workspace host. " +
			"Call this first when a Playwright run fails for an unclear reason.",
		Schema: obj(map[string]any{}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			s := playwright.Detect(env.Root)
			var sb strings.Builder
			fmt.Fprintf(&sb, "node:    %s\n", orNone(s.NodePath))
			fmt.Fprintf(&sb, "CLI:     %s\n", orNone(s.CLIPath))
			sb.WriteString("Execution host: workspace host (remote server when using SSH). Tests launch via node, without a shell or implicit package downloads.\n")
			if s.ConfigPath != "" {
				fmt.Fprintf(&sb, "config:  %s\n", env.Rel(s.ConfigPath))
			} else {
				sb.WriteString("config:  (none found)\n")
			}
			if s.Installed {
				v := s.Version
				if v == "" {
					v = "unknown version"
				}
				fmt.Fprintf(&sb, "package: @playwright/test %s\n", v)
			} else {
				sb.WriteString("package: not installed\n")
			}
			if err := s.Ready(); err != nil {
				fmt.Fprintf(&sb, "\nNot ready: %v", err)
			} else {
				sb.WriteString("\nReady to run tests.")
			}
			if s.NodePath != "" && s.Installed {
				sb.WriteString("\nDeclarative layout replay is available without a test config; browser installation is checked at launch.")
			}
			return Ok(sb.String())
		},
	})

	r.Add(&Tool{
		Name: "playwright_test",
		Description: "Run this project's Playwright suite and report which specs passed and " +
			"failed, with the assertion message and source location for each failure. " +
			"Use it to verify web work against the project's real tests. Narrow the run " +
			"with `spec` or `grep` while iterating on one failure — a full suite is slow.",
		Mutating: true,
		Schema: obj(map[string]any{
			"spec":             str("Spec file, or file:line, to run. Optional; omit to run everything."),
			"grep":             str("Only run tests whose title matches this. Optional."),
			"project":          str("Playwright project name from the config, e.g. 'chromium'. Optional."),
			"workers":          num("Parallel workers. Optional; omit to use the config's value. Use 1 to make failures deterministic."),
			"timeout_seconds":  num("Give up after this long. Default 600."),
			"update_snapshots": boolp("Rewrite snapshot files to match current output. Default false."),
		}),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Spec string `json:"spec"`
				Grep string `json:"grep"`
			}
			_ = json.Unmarshal(in, &a)
			switch {
			case a.Spec != "":
				return "Run Playwright tests in " + a.Spec
			case a.Grep != "":
				return "Run Playwright tests matching " + a.Grep
			default:
				return "Run the Playwright suite"
			}
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Spec            string `json:"spec"`
				Grep            string `json:"grep"`
				Project         string `json:"project"`
				Workers         int    `json:"workers"`
				TimeoutSeconds  int    `json:"timeout_seconds"`
				UpdateSnapshots bool   `json:"update_snapshots"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}

			s := playwright.Detect(env.Root)
			if err := s.Ready(); err != nil {
				return Errf("%v\n\nCall playwright_status for the full picture.", err)
			}

			if env.Emit != nil {
				env.Emit("status", map[string]any{"text": "running Playwright tests…"})
			}

			rep, err := playwright.Run(ctx, s, playwright.RunOptions{
				Spec:            a.Spec,
				Grep:            a.Grep,
				Project:         a.Project,
				Workers:         a.Workers,
				Timeout:         time.Duration(a.TimeoutSeconds) * time.Second,
				UpdateSnapshots: a.UpdateSnapshots,
			})
			if err != nil {
				return Errf("%v", err)
			}

			out := formatReport(rep, env)
			if rep.OK() {
				return Ok(out)
			}
			return Result{Output: out, IsError: true}
		},
	})

	r.Add(&Tool{
		Name: "playwright_install",
		Description: "Download the browser binaries Playwright needs. Run this when a test " +
			"fails with a missing-executable error, which is the usual state of a fresh " +
			"server. On Linux, also installs the system libraries the browser links against.",
		Mutating: true,
		Schema: obj(map[string]any{
			"with_deps": boolp("Also install OS-level dependencies (Linux only, needs root). Default true on Linux."),
		}),
		Summarize: func(json.RawMessage) string { return "Install Playwright browsers" },
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				WithDeps *bool `json:"with_deps"`
			}
			_ = json.Unmarshal(in, &a)
			withDeps := a.WithDeps == nil || *a.WithDeps

			s := playwright.Detect(env.Root)
			if s.NpxPath == "" {
				return Errf("npx is not on PATH — install Node.js on this machine first")
			}
			if env.Emit != nil {
				env.Emit("status", map[string]any{"text": "installing Playwright browsers…"})
			}
			out, err := playwright.InstallBrowsers(ctx, s, withDeps)
			if err != nil {
				return Errf("%v\n\n%s", err, out)
			}
			return Ok("Playwright browsers installed.\n\n" + out)
		},
	})
}

func orNone(s string) string {
	if s == "" {
		return "(not found)"
	}
	return s
}

func formatReport(rep *playwright.Report, env *Env) string {
	var sb strings.Builder

	fmt.Fprintf(&sb, "%d passed, %d failed", rep.Passed, rep.Failed)
	if rep.Flaky > 0 {
		fmt.Fprintf(&sb, ", %d flaky", rep.Flaky)
	}
	if rep.Skipped > 0 {
		fmt.Fprintf(&sb, ", %d skipped", rep.Skipped)
	}
	if rep.Duration > 0 {
		fmt.Fprintf(&sb, "  (%s)", rep.Duration.Round(100*time.Millisecond))
	}
	sb.WriteString("\n")

	for _, e := range rep.TopLevelErrors {
		fmt.Fprintf(&sb, "\nError: %s\n", e)
	}

	for _, f := range rep.Failures {
		sb.WriteString("\n")
		loc := f.File
		if f.Line > 0 {
			loc = fmt.Sprintf("%s:%d", f.File, f.Line)
		}
		if f.Project != "" {
			fmt.Fprintf(&sb, "FAIL [%s] %s\n     %s\n", f.Project, f.Title, loc)
		} else {
			fmt.Fprintf(&sb, "FAIL %s\n     %s\n", f.Title, loc)
		}
		if f.Message != "" {
			for _, line := range strings.Split(f.Message, "\n") {
				fmt.Fprintf(&sb, "     %s\n", line)
			}
		}
		for _, at := range f.Attachments {
			fmt.Fprintf(&sb, "     artefact: %s\n", env.Rel(at))
		}
	}

	if rep.RawTail != "" {
		sb.WriteString("\nOutput:\n")
		sb.WriteString(rep.RawTail)
		sb.WriteString("\n")
	}

	if rep.OK() {
		sb.WriteString("\nAll tests passed.")
	}
	return sb.String()
}
