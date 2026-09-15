package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/mflores/mfagent/core/internal/playwright"
)

func RegisterPlaywright(r *Registry) {
	registerPlaywrightCLI(r)
	r.Add(&Tool{
		Name: "playwright_status",
		Description: "Report the Playwright runtime available here: where it came from, its " +
			"version, the config file in use, Node, and the browser builds present on the " +
			"workspace host. The extension ships its own runtime, so this is normally ready " +
			"with no project setup. Call it first when a Playwright run fails unclearly.",
		Schema: obj(map[string]any{"cwd": str("Suite directory relative to the workspace, e.g. tests/e2e. Use the same cwd for status, install and test. Optional.")}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			s, err := playwrightSetup(env, in)
			if err != nil {
				return Errf("%v", err)
			}
			var sb strings.Builder
			fmt.Fprintf(&sb, "runtime: %s\n", s.Describe())
			fmt.Fprintf(&sb, "node:    %s\n", orNone(s.NodePath))
			fmt.Fprintf(&sb, "CLI:     %s\n", orNone(s.CLIPath))
			fmt.Fprintf(&sb, "interactive CLI: %s (playwright_cli; docs: playwright_skill)\n", orNone(playwright.CLIPath()))
			if s.Installed {
				v := s.Version
				if v == "" {
					v = "unknown version"
				}
				fmt.Fprintf(&sb, "package: @playwright/test %s\n", v)
			} else {
				sb.WriteString("package: none resolved\n")
			}
			fmt.Fprintf(&sb, "specs:   %s\n", s.Root)
			if s.ConfigPath != "" {
				fmt.Fprintf(&sb, "config:  %s\n", env.Rel(s.ConfigPath))
			} else {
				sb.WriteString("config:  (none found; Playwright defaults apply, or select an explicit spec)\n")
			}
			if browsers := playwright.ChromiumPaths(); len(browsers) > 0 {
				fmt.Fprintf(&sb, "cache inventory: %d Chromium build(s), first %s (does not establish suite compatibility)\n", len(browsers), browsers[0])
			} else {
				sb.WriteString("browsers: none downloaded yet — playwright_install fetches them\n")
			}
			sb.WriteString("Execution host: workspace host (the remote server when using SSH). Tests launch via node, without a shell.\n")

			if err := s.Ready(); err != nil {
				fmt.Fprintf(&sb, "\nNot ready: %v", err)
				return Ok(sb.String())
			}
			probe, probeErr := playwright.ProbeChromium(ctx, s)
			fmt.Fprintf(&sb, "\nDefault headless Chromium probe (suite custom launch options are checked by playwright_test):\n%s\n", probe)
			if probeErr != nil {
				fmt.Fprintf(&sb, "Browser not ready: %v\n%s\n", probeErr, playwrightFailureGuidance(probe, in))
			}
			sb.WriteString("\nTest runner resolved. The extension provides " +
				"a fallback runtime, so no project npm install is needed unless the owner explicitly requires " +
				"a project-owned harness. Use the same cwd for playwright_status, playwright_install and playwright_test.")
			sb.WriteString("\nDeclarative layout replay is available without a test config; browser installation is checked at launch.")
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
			"cwd":              str("Suite directory relative to the workspace, e.g. tests/e2e. Resolves config and pinned dependencies here. Optional."),
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

			s, setupErr := playwrightSetup(env, in)
			if setupErr != nil {
				return Errf("%v", setupErr)
			}
			if err := s.Ready(); err != nil {
				return Errf("%v\n\nCall playwright_status for the full picture.", err)
			}

			if env.Emit != nil {
				env.Emit("status", map[string]any{"text": "running Playwright tests…"})
			}

			rep, repair, err := playwright.RunWithBrowserRepair(ctx, s, playwright.RunOptions{
				Spec:            a.Spec,
				Grep:            a.Grep,
				Project:         a.Project,
				Workers:         a.Workers,
				Timeout:         time.Duration(a.TimeoutSeconds) * time.Second,
				UpdateSnapshots: a.UpdateSnapshots,
			}, func(text string) {
				if env.Emit != nil {
					env.Emit("status", map[string]any{"text": text})
				}
			})
			if err != nil {
				return Result{IsError: true, Output: env.RedactTestingSecrets(fmt.Sprintf("%s\n%v\nStop repeating this repair; report the observed host blocker and required change.", repair, err))}
			}

			out := formatReport(rep, env)
			if repair != "" {
				out = repair + "\n" + out
			}
			if !rep.OK() {
				if repair != "" && playwright.BrowserFailure(out) == "missing_chromium" {
					out += "\nChromium is still missing after one repair. Stop retrying; inspect the reported runtime/cache permissions on the workspace host. Do not install from another directory."
				} else {
					out += "\n" + playwrightFailureGuidance(out, in)
				}
			}
			out = env.RedactTestingSecrets(out)
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
			"server. Select the same cwd as playwright_test. Set with_deps:true only when Linux system libraries are missing.",
		Mutating: true,
		Schema: obj(map[string]any{
			"cwd":       str("Suite directory; use the same cwd as playwright_test so browser revisions match. Optional."),
			"with_deps": boolp("Also install OS-level dependencies (Linux only, needs root). Default false; enable for diagnosed missing libraries."),
		}),
		Summarize: func(json.RawMessage) string { return "Install Playwright browsers" },
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				WithDeps *bool `json:"with_deps"`
			}
			_ = json.Unmarshal(in, &a)
			withDeps := a.WithDeps != nil && *a.WithDeps

			s, setupErr := playwrightSetup(env, in)
			if setupErr != nil {
				return Errf("%v", setupErr)
			}
			if err := s.Ready(); err != nil {
				return Errf("%v", err)
			}
			if env.Emit != nil {
				env.Emit("status", map[string]any{"text": "installing Playwright browsers…"})
			}
			out, err := playwright.InstallBrowsers(ctx, s, withDeps)
			if err != nil {
				return Result{IsError: true, Output: env.RedactTestingSecrets(fmt.Sprintf("%v\n\n%s\nDo not repeat the installation without resolving this host error.", err, out))}
			}
			probe, probeErr := playwright.ProbeChromium(ctx, s)
			result := env.RedactTestingSecrets("Playwright browser download completed.\n\n" + out + "\n" + probe)
			if probeErr != nil {
				return Result{IsError: true, Output: result + "\n" + playwrightFailureGuidance(probe, in)}
			}
			return Ok(result)
		},
	})
}

func playwrightFailureGuidance(output string, in json.RawMessage) string {
	var args struct {
		Cwd string `json:"cwd"`
	}
	_ = json.Unmarshal(in, &args)
	install, _ := json.Marshal(map[string]any{"cwd": args.Cwd, "with_deps": playwright.BrowserFailure(output) == "missing_libraries"})
	switch playwright.BrowserFailure(output) {
	case "missing_chromium":
		return "Missing suite browser: call playwright_install " + string(install) + ". Keep the same cwd for the test. Other cached revisions and laptop browsers do not satisfy this remote runtime."
	case "missing_libraries":
		return "Missing Linux libraries: call playwright_install " + string(install) + ". Requires root or passwordless sudo on the workspace host; a failed install is a host blocker."
	case "missing_display":
		return "No display on the SSH host. Use headless:true in the suite launch configuration and remove PWDEBUG/--headed for unattended runs. A deliberately headed test needs a configured X server; do not retry unchanged."
	case "sandbox":
		return "Chromium sandbox cannot start on this host. Inspect the suite launch options and host user/container restrictions. Root cannot launch with chromiumSandbox:true; do not change the target URL or retry unchanged."
	default:
		return ""
	}
}

func playwrightSetup(env *Env, in json.RawMessage) (*playwright.Setup, error) {
	var args struct {
		Cwd string `json:"cwd"`
	}
	if err := json.Unmarshal(in, &args); err != nil {
		return nil, err
	}
	root := env.Root
	if args.Cwd != "" {
		var err error
		root, err = env.Resolve(args.Cwd)
		if err != nil {
			return nil, err
		}
	}
	setup := playwright.Detect(root)
	if args.Cwd != "" || strings.TrimSpace(os.Getenv("MFAGENT_PLAYWRIGHT_ROOT")) != "" || setup.ConfigPath != "" {
		return setup, nil
	}
	// The verifier's mandatory check has no model-selected cwd. Resolve a single
	// conventional suite instead of silently using the parent runtime/version.
	var suites []*playwright.Setup
	var names []string
	for _, candidate := range []string{"tests/e2e", "e2e", "tests"} {
		resolved, err := env.Resolve(candidate)
		if err != nil {
			continue
		}
		nested := playwright.Detect(resolved)
		if nested.ConfigPath != "" {
			suites = append(suites, nested)
			names = append(names, candidate)
		}
	}
	if len(suites) > 1 {
		return nil, fmt.Errorf("multiple Playwright suites found: %s; select cwd explicitly for status, install and test, or set the owner-selected MFAGENT_PLAYWRIGHT_ROOT for mandatory verification", strings.Join(names, ", "))
	}
	if len(suites) == 1 {
		return suites[0], nil
	}
	return setup, nil
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
		sb.WriteString("\nExecuted tests passed.")
	} else if rep.Passed+rep.Flaky+rep.Failed == 0 && len(rep.TopLevelErrors) == 0 {
		sb.WriteString("\nNo tests executed. An empty or entirely skipped run does not verify the requested behavior.")
	}
	return sb.String()
}
