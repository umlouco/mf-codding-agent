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

// deniedPatterns are refused outright. This is a guardrail against obvious
// footguns, not a security boundary — the permission prompt is the boundary.
var deniedPatterns = []string{
	"rm -rf /", "rm -rf /*", ":(){", "mkfs", "dd if=/dev/zero of=/dev",
	"format c:", "Remove-Item -Path C:\\ -Recurse",
}

func RegisterShell(r *Registry) {
	r.Add(&Tool{
		Name: "run_shell",
		Description: "Run a shell command in the workspace (PowerShell on Windows, sh elsewhere). " +
			"Use for builds, test suites, package managers, git and compilers — " +
			"composer, npm/pnpm, go build/test, dcc32/msbuild, php. " +
			"Prefer the unix tool for plain file inspection and text processing. " +
			"Returns combined stdout and stderr plus the exit code.",
		Mutating: true,
		Schema: obj(map[string]any{
			"command":     str("The command line to execute."),
			"cwd":         str("Working directory relative to the workspace root. Optional."),
			"timeout_ms":  num("Timeout in milliseconds. Default 120000, maximum 600000."),
			"description": str("One short sentence describing what this does, shown in the approval prompt."),
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

			name, args, cleanup := shellFor(a.Command)
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
