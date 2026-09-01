package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"
)

func lookPath(name string) (string, error) { return exec.LookPath(name) }

// shellFor picks the host shell. Nothing here is Unix-specific: on Windows we
// use PowerShell, elsewhere sh.
//
// On Windows the script is handed over base64-encoded rather than as a quoted
// argument, and that is the whole reason quoting bugs stop here.
//
// A Windows process does not receive an argument vector; it receives one string
// and parses it itself. Go builds that string with C-runtime rules — double
// quotes, backslash escapes — and PowerShell then re-parses it with completely
// different rules, where the escape character is a backtick and a quote is
// doubled. Any script containing a quote, a dollar sign or a backtick is
// therefore rewritten in transit by two layers that disagree, which is why
// `-Command` breaks on exactly the commands worth running. `-EncodedCommand`
// takes UTF-16LE base64: the argument is alphanumeric, so neither layer can
// touch it, and PowerShell decodes the script byte for byte.
//
// Returns a cleanup to run once the command has finished.
func shellFor(cmd string) (string, []string, func()) {
	if runtime.GOOS != "windows" {
		return "/bin/sh", []string{"-c", cmd}, func() {}
	}

	exe := "powershell.exe"
	if ps, err := exec.LookPath("pwsh"); err == nil {
		exe = ps
	}

	// Windows caps a command line at 32767 characters and UTF-16LE base64 costs
	// 2.67 bytes per source character, so a long script has to travel as a file
	// instead. -File takes the path as a plain argument and reads the script off
	// disk, so it is exactly as quote-proof as the encoded form.
	if encoded := encodePowerShell(cmd); len(encoded) < 30000 {
		return exe, []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", encoded}, func() {}
	}

	f, err := os.CreateTemp("", "mfagent-*.ps1")
	if err != nil {
		// Nothing left to fall back to; the encoded form at least fails loudly
		// at the length limit rather than silently mangling the script.
		return exe, []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(cmd)}, func() {}
	}
	path := f.Name()
	// The BOM is what tells PowerShell the file is UTF-8 rather than the ANSI
	// codepage, which would corrupt every non-ASCII character in the script.
	_, _ = f.WriteString("\xEF\xBB\xBF" + cmd)
	_ = f.Close()
	return exe, []string{"-NoProfile", "-NonInteractive", "-File", path}, func() { _ = os.Remove(path) }
}

// encodePowerShell renders a script as the UTF-16LE base64 blob that
// -EncodedCommand expects.
func encodePowerShell(cmd string) string {
	units := utf16.Encode([]rune(cmd))
	b := make([]byte, 0, len(units)*2)
	for _, u := range units {
		b = append(b, byte(u), byte(u>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

// deniedPatterns are refused outright.
//
// Nothing asks the user before a command runs, so this list and the workspace
// confinement in Env.Resolve are the whole guard. It is still only a guardrail
// against the obvious footguns — a denylist of literal strings cannot be a
// security boundary, and treating it as one is how it ends up trusted for
// something it was never able to do.
var deniedPatterns = []string{
	"rm -rf /", "rm -rf /*", ":(){", "mkfs", "dd if=/dev/zero of=/dev",
	"format c:", "Remove-Item -Path C:\\ -Recurse",
}

// runInTerminal runs one command through the editor's terminal and renders the
// result in exactly the shape the spawned path produces, so which one handled a
// call is not something the model has to reason about.
//
// The one difference it cannot hide is a missing exit code. VS Code only knows
// how a command ended when shell integration is active for that shell, and
// reporting an unknown status as 0 would turn "we could not tell" into "it
// worked" — the single most expensive lie this tool could tell, since every
// verification step downstream is built on it.
func runInTerminal(ctx context.Context, env *Env, dir, command string, timeout time.Duration) Result {
	run, err := env.EditorTerminal(ctx, dir, command, int(timeout.Milliseconds()))
	if err != nil {
		return Errf("could not run %q in the editor terminal: %v", command, err)
	}

	body := clamp(strings.TrimRight(run.Output, "\r\n"), 60000)
	if strings.TrimSpace(body) == "" {
		body = "(no output)"
	}
	if run.TimedOut {
		return Result{
			Output: fmt.Sprintf("Command timed out after %s. It may still be running in the "+
				"terminal — check there before running it again.\n\n%s", timeout, clamp(body, 30000)),
			IsError: true,
		}
	}

	meta := map[string]any{"terminal": true}
	if run.ExitCode == nil {
		return Result{
			Output: fmt.Sprintf("exit=unknown cwd=%s\n%s\n\n"+
				"The terminal could not report an exit status for this command, so whether it "+
				"succeeded is not established — read the output above, or verify another way "+
				"before relying on it.", env.Rel(dir), body),
			Meta: meta,
		}
	}
	meta["exitCode"] = *run.ExitCode
	return Result{
		Output:  fmt.Sprintf("exit=%d cwd=%s\n%s", *run.ExitCode, env.Rel(dir), body),
		IsError: *run.ExitCode != 0,
		Meta:    meta,
	}
}

func RegisterShell(r *Registry) {
	r.Add(&Tool{
		Name: "run_shell",
		Description: "Run a shell command in the workspace (PowerShell on Windows, sh elsewhere). " +
			"Use for builds, test suites, package managers, git and compilers — " +
			"composer, npm/pnpm, go build/test, dcc32/msbuild, php. " +
			"Simple && command chains are accepted on Windows and retain stop-on-error semantics. " +
			"When the editor offers a terminal this runs there, in the user's own " +
			"configured shell and visible in a tab they can scroll back through, so " +
			"a long build can be watched rather than waited on. " +
			"Prefer the unix tool for plain file inspection and text processing. " +
			"Returns combined stdout and stderr plus the exit code.",
		Mutating: true,
		Schema: obj(map[string]any{
			"command":     str("The command line to execute."),
			"cwd":         str("Working directory relative to the workspace root. Optional."),
			"timeout_ms":  num("Timeout in milliseconds. Default 120000, maximum 600000."),
			"description": str("One short sentence describing what this does, shown in the chat while it runs."),
		}, "command"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Command     string `json:"command"`
				Description string `json:"description"`
			}
			_ = json.Unmarshal(in, &a)
			if a.Description != "" {
				return a.Description + "  —  " + a.Command
			}
			return a.Command
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Command     string `json:"command"`
				Cwd         string `json:"cwd"`
				TimeoutMS   int    `json:"timeout_ms"`
				Description string `json:"description"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if strings.TrimSpace(a.Command) == "" {
				return Errf("command is empty")
			}
			low := strings.ToLower(a.Command)
			for _, d := range deniedPatterns {
				if strings.Contains(low, strings.ToLower(d)) {
					return Errf("refusing to run a command matching the destructive pattern %q", d)
				}
			}

			dir := env.Root
			if a.Cwd != "" {
				var err error
				if dir, err = env.Resolve(a.Cwd); err != nil {
					return Errf("%v", err)
				}
			}

			timeout := 120 * time.Second
			if a.TimeoutMS > 0 {
				timeout = time.Duration(a.TimeoutMS) * time.Millisecond
			}
			if timeout > 10*time.Minute {
				timeout = 10 * time.Minute
			}
			cctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()

			// The editor's terminal is preferred whenever there is one: it runs
			// the command in the shell the user actually configured and leaves
			// it on screen. Spawning below is the fallback for when there is no
			// editor listening at all.
			if env.EditorTerminal != nil {
				return runInTerminal(cctx, env, dir, a.Command, timeout)
			}

			command := a.Command
			if runtime.GOOS == "windows" {
				command = powerShellCompatible(command)
			}
			name, args, cleanup := shellFor(command)
			defer cleanup()
			cmd := exec.CommandContext(cctx, name, args...)
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "MFAGENT=1", "NO_COLOR=1", "CI=1")

			var buf bytes.Buffer
			cmd.Stdout = &buf
			cmd.Stderr = &buf
			cmd.Stdin = nil

			start := time.Now()
			err := cmd.Run()
			elapsed := time.Since(start).Round(time.Millisecond)

			out := strings.TrimRight(buf.String(), "\r\n")
			if runtime.GOOS == "windows" {
				out = cleanPowerShellOutput(out)
			}
			exitCode := 0
			if err != nil {
				if ee, ok := err.(*exec.ExitError); ok {
					exitCode = ee.ExitCode()
				} else if cctx.Err() == context.DeadlineExceeded {
					return Result{
						Output:  fmt.Sprintf("Command timed out after %s.\n\n%s", timeout, clamp(out, 30000)),
						IsError: true,
					}
				} else {
					return Errf("failed to start %q: %v", a.Command, err)
				}
			}

			header := fmt.Sprintf("exit=%d elapsed=%s cwd=%s", exitCode, elapsed, env.Rel(dir))
			body := clamp(out, 60000)
			if strings.TrimSpace(body) == "" {
				body = "(no output)"
			}
			return Result{
				Output:  header + "\n" + body,
				IsError: exitCode != 0,
				Meta:    map[string]any{"exitCode": exitCode, "elapsedMs": elapsed.Milliseconds()},
			}
		},
	})

	r.Add(&Tool{
		Name: "project_info",
		Description: "Detect the project's languages, build tooling and entry points. " +
			"Call this once at the start of a task in an unfamiliar repository.",
		Schema: obj(map[string]any{}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			return Ok(detectProject(env.Root))
		},
	})
}

type marker struct {
	file  string
	label string
}

var projectMarkers = []marker{
	{"composer.json", "PHP (Composer)"},
	{"artisan", "PHP — Laravel"},
	{"wp-config.php", "PHP — WordPress"},
	{"package.json", "JavaScript/TypeScript (npm)"},
	{"pnpm-lock.yaml", "pnpm workspace"},
	{"yarn.lock", "yarn"},
	{"bun.lockb", "bun"},
	{"tsconfig.json", "TypeScript"},
	{"vite.config.ts", "Vite"},
	{"next.config.js", "Next.js"},
	{"go.mod", "Go module"},
	{"go.work", "Go workspace"},
	{"Makefile", "make"},
	{"docker-compose.yml", "Docker Compose"},
	{"Dockerfile", "Docker"},
	{".env.example", "env template"},
}

func detectProject(root string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Workspace: %s\n\n", filepath.ToSlash(root))

	sb.WriteString("Detected tooling:\n")
	found := false
	for _, m := range projectMarkers {
		if _, err := os.Stat(filepath.Join(root, m.file)); err == nil {
			fmt.Fprintf(&sb, "  - %s (%s)\n", m.label, m.file)
			found = true
		}
	}
	if !found {
		sb.WriteString("  (no standard project markers at the root)\n")
	}

	// Count source files per language so the agent knows what it is dealing with.
	counts := map[string]int{}
	_ = filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if fi.IsDir() {
			if p != root && skipDirs[fi.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		for lang, exts := range langGlobs {
			for _, e := range exts {
				if ext == e {
					counts[lang]++
				}
			}
		}
		return nil
	})
	if len(counts) > 0 {
		sb.WriteString("\nSource files by language:\n")
		for _, lang := range []string{"php", "ts", "js", "go", "delphi", "web", "sql", "config"} {
			if n := counts[lang]; n > 0 {
				fmt.Fprintf(&sb, "  - %-8s %d\n", lang, n)
			}
		}
	}

	// Delphi projects rarely have a lockfile; look for .dpr/.dproj.
	var delphiProjects []string
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		n := strings.ToLower(e.Name())
		if strings.HasSuffix(n, ".dpr") || strings.HasSuffix(n, ".dproj") || strings.HasSuffix(n, ".groupproj") {
			delphiProjects = append(delphiProjects, e.Name())
		}
	}
	if len(delphiProjects) > 0 {
		fmt.Fprintf(&sb, "\nDelphi projects: %s\n", strings.Join(delphiProjects, ", "))
	}

	if data, err := os.ReadFile(filepath.Join(root, "package.json")); err == nil {
		var pkg struct {
			Scripts map[string]string `json:"scripts"`
		}
		if json.Unmarshal(data, &pkg) == nil && len(pkg.Scripts) > 0 {
			sb.WriteString("\nnpm scripts:\n")
			for k, v := range pkg.Scripts {
				fmt.Fprintf(&sb, "  - %s: %s\n", k, v)
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "composer.json")); err == nil {
		var pkg struct {
			Scripts map[string]any `json:"scripts"`
		}
		if json.Unmarshal(data, &pkg) == nil && len(pkg.Scripts) > 0 {
			sb.WriteString("\ncomposer scripts:\n")
			for k := range pkg.Scripts {
				fmt.Fprintf(&sb, "  - %s\n", k)
			}
		}
	}

	return sb.String()
}
