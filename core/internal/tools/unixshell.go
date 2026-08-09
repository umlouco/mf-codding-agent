package tools

// A POSIX shell that behaves identically on Windows, macOS and Linux.
//
// Shell syntax — pipelines, && and ||, for/while/if, command substitution,
// globbing, here-documents, variables and redirection — comes from mvdan.cc/sh,
// a parser and interpreter written in Go. The utilities themselves (grep, sed,
// awk, …) are the Go builtins in posix.go and posixutil.go, so a script means
// the same thing on every platform with no busybox, WSL or Git Bash installed.
//
// Anything without a Go implementation falls through to the host shell —
// PowerShell on Windows, /bin/sh elsewhere — so builds, package managers and
// git compose into the same script as the portable utilities.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/interp"
	"mvdan.cc/sh/v3/syntax"
)

// lockedBuffer collects stdout and stderr. A pipeline runs its stages on
// separate goroutines and every stage's stderr lands in the same place, so
// these writes are genuinely concurrent and a bare bytes.Buffer would race.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// scriptEnv marks the environment the same way run_shell does, so tooling that
// checks for CI or disables colour behaves consistently across both tools.
func scriptEnv() []string {
	return append(os.Environ(), "MFAGENT=1", "NO_COLOR=1", "CI=1")
}

// RunScript runs one script through the portable interpreter, for callers
// outside the agent loop — see `mfcore sh`, which is how the extension runs a
// task's verification command with the same shell semantics the agent used to
// satisfy it. A check that disagrees with the build about what `&&` means is
// worse than no check at all.
func RunScript(ctx context.Context, env *Env, dir, script string) (string, uint8, error) {
	return runScript(ctx, env, dir, script)
}

// runScript interprets one script rooted at dir and returns its combined
// output together with the exit status. A non-zero status is not a Go error:
// it is reported through the status return so && and || behave normally.
func runScript(ctx context.Context, env *Env, dir, script string) (string, uint8, error) {
	file, err := syntax.NewParser().Parse(strings.NewReader(script), "")
	if err != nil {
		return "", 0, fmt.Errorf("parse error: %w", err)
	}

	var out lockedBuffer
	runner, err := interp.New(
		interp.Dir(dir),
		interp.Env(expand.ListEnviron(scriptEnv()...)),
		interp.StdIO(nil, &out, &out),
		interp.ExecHandler(dispatch(env)),
		interp.OpenHandler(confinedOpen(env)),
	)
	if err != nil {
		return "", 0, err
	}

	runErr := runner.Run(ctx, file)
	if runErr == nil {
		return out.String(), 0, nil
	}
	if status, ok := interp.IsExitStatus(runErr); ok {
		return out.String(), status, nil
	}
	return out.String(), 0, runErr
}

// dispatch routes a command to its Go implementation when one exists, and to
// the host shell otherwise. It is only reached for commands the interpreter
// does not handle itself — cd, echo, printf, test, read and the other shell
// builtins never arrive here.
func dispatch(env *Env) interp.ExecHandlerFunc {
	var self interp.ExecHandlerFunc
	self = func(ctx context.Context, args []string) error {
		if len(args) == 0 {
			return nil
		}
		hc := interp.HandlerCtx(ctx)
		b, ok := builtins[args[0]]
		if !ok {
			return runOnHost(ctx, hc, args)
		}
		c := &cmdCtx{
			ctx:  ctx,
			env:  env,
			dir:  hc.Dir,
			args: args[1:],
			in:   hc.Stdin,
			out:  hc.Stdout,
			errw: hc.Stderr,
			// Both are func(context.Context, []string) error but they are
			// distinct named types, so the conversion has to be explicit.
			exec: execFunc(self),
		}
		if err := b.fn(c); err != nil {
			// A status a command reports on purpose — diff finding a
			// difference, grep finding no match — is not a failure to report.
			var code exitCodeError
			if errors.As(err, &code) {
				return interp.NewExitStatus(uint8(code))
			}
			fmt.Fprintf(hc.Stderr, "%s: %v\n", args[0], err)
			return interp.NewExitStatus(1)
		}
		return nil
	}
	return self
}

// runOnHost runs a command that has no Go implementation.
//
// A real program is executed directly, with the argument vector the POSIX
// parser already produced and no shell anywhere in the path. That is not an
// optimisation — it is the difference between arguments that survive and
// arguments that get re-parsed. Handing `go build ./...` to PowerShell means
// pasting the arguments back into one string for a second parser with different
// quoting rules to split again, and every quote, dollar sign and backtick in
// them is a chance to come out the other side as something else.
//
// The shell is kept only for what genuinely needs it: .cmd and .bat shims like
// npm and yarn, which are scripts rather than programs, and bare cmdlet names
// that are not on disk at all.
func runOnHost(ctx context.Context, hc interp.HandlerContext, args []string) error {
	cmd, cleanup, viaShell := hostCommand(ctx, hc.Dir, args)
	defer cleanup()
	cmd.Dir = hc.Dir
	cmd.Env = scriptEnv()
	cmd.Stdin = hc.Stdin
	cmd.Stdout = hc.Stdout

	// PowerShell serialises its own error records as a CLIXML document when its
	// stderr is a pipe, so anything it complains about — a name it cannot
	// resolve, most often — arrives as unreadable XML. Direct execution never
	// does this, so only the shell path pays for the translation.
	stderr := hc.Stderr
	var psErr bytes.Buffer
	if viaShell && runtime.GOOS == "windows" {
		cmd.Stderr = &psErr
	} else {
		cmd.Stderr = stderr
	}

	err := cmd.Run()
	if psErr.Len() > 0 {
		fmt.Fprint(stderr, decodeCLIXML(psErr.String()))
	}
	if err == nil {
		return nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code := ee.ExitCode()
		if code < 0 || code > 255 {
			code = 1
		}
		return interp.NewExitStatus(uint8(code))
	}
	fmt.Fprintf(hc.Stderr, "%s: %v\n", args[0], err)
	return interp.NewExitStatus(127)
}

// hostCommand builds the process for one command, and reports whether it had to
// go through a shell to do it.
func hostCommand(ctx context.Context, dir string, args []string) (*exec.Cmd, func(), bool) {
	if path, ok := resolveProgram(dir, args[0]); ok && !needsShell(path) {
		return exec.CommandContext(ctx, path, args[1:]...), func() {}, false
	}
	name, shArgs, cleanup := shellFor(hostCommandLine(args))
	return exec.CommandContext(ctx, name, shArgs...), cleanup, true
}

// needsShell reports whether a resolved path is a script that an interpreter
// has to read rather than a program the OS can start.
func needsShell(path string) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".cmd", ".bat", ".ps1":
		return true
	}
	return false
}

// resolveProgram finds the program a command name refers to. A name containing
// a separator is a path and is resolved against the script's own directory —
// PATH has nothing to do with `./scripts/build.sh`.
func resolveProgram(dir, name string) (string, bool) {
	if !strings.ContainsAny(name, `/\`) {
		path, err := exec.LookPath(name)
		return path, err == nil
	}

	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, path)
	}
	if st, err := os.Stat(path); err == nil && !st.IsDir() {
		return path, true
	}
	// On Windows the extension is usually left implicit.
	if runtime.GOOS == "windows" {
		for _, ext := range filepath.SplitList(os.Getenv("PATHEXT")) {
			if st, err := os.Stat(path + ext); err == nil && !st.IsDir() {
				return path + ext, true
			}
		}
	}
	return "", false
}

// decodeCLIXML turns PowerShell's serialised error stream back into the text a
// human — or a supervisor agent reading a failed check — was supposed to see.
// Anything that is not a CLIXML document is passed through untouched.
func decodeCLIXML(s string) string {
	if !strings.HasPrefix(strings.TrimSpace(s), "#< CLIXML") {
		return s
	}
	var b strings.Builder
	rest := s
	for {
		i := strings.Index(rest, `<S S="Error">`)
		if i < 0 {
			break
		}
		rest = rest[i+len(`<S S="Error">`):]
		j := strings.Index(rest, "</S>")
		if j < 0 {
			break
		}
		b.WriteString(rest[:j])
		rest = rest[j+len("</S>"):]
	}
	if b.Len() == 0 {
		return s
	}
	// The serialiser escapes the line breaks and the XML entities it needs to.
	out := b.String()
	for _, r := range []struct{ from, to string }{
		{"_x000D__x000A_", "\n"}, {"_x000A_", "\n"}, {"_x000D_", "\n"},
		{"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", `"`}, {"&apos;", "'"},
	} {
		out = strings.ReplaceAll(out, r.from, r.to)
	}
	return out
}

// hostCommandLine re-quotes an already-tokenised command for the host shell.
// The POSIX parser has stripped the original quoting, so every argument is
// re-wrapped verbatim — doubled '' for PowerShell, '\'' for sh — rather than
// pasted back together and re-split by a second shell with different rules.
func hostCommandLine(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		if runtime.GOOS == "windows" {
			quoted = append(quoted, "'"+strings.ReplaceAll(a, "'", "''")+"'")
		} else {
			quoted = append(quoted, "'"+strings.ReplaceAll(a, "'", `'\''`)+"'")
		}
	}
	line := strings.Join(quoted, " ")
	if runtime.GOOS == "windows" {
		// PowerShell needs the call operator to invoke a quoted command name.
		return "& " + line
	}
	return line
}

// confinedOpen routes every redirection through Env.Resolve. The shell is
// otherwise unrestricted, but `> ../../outside.txt` still cannot escape the
// workspace, and the editor is told about files the script rewrote.
func confinedOpen(env *Env) interp.OpenHandlerFunc {
	def := interp.DefaultOpenHandler()
	return func(ctx context.Context, path string, flag int, perm os.FileMode) (io.ReadWriteCloser, error) {
		if path == "" || path == os.DevNull || path == "/dev/null" {
			return def(ctx, path, flag, perm)
		}
		hc := interp.HandlerCtx(ctx)
		if !filepath.IsAbs(path) {
			path = filepath.Join(hc.Dir, path)
		}
		abs, err := env.Resolve(path)
		if err != nil {
			return nil, err
		}
		f, err := def(ctx, abs, flag, perm)
		if err != nil || flag&(os.O_WRONLY|os.O_RDWR) == 0 || env.FileChanged == nil {
			return f, err
		}
		return &notifyOnClose{ReadWriteCloser: f, path: abs, env: env}, nil
	}
}

// notifyOnClose tells the editor a file changed once the script finished
// writing it, matching what write_file and edit_file do.
type notifyOnClose struct {
	io.ReadWriteCloser
	path string
	env  *Env
}

func (n *notifyOnClose) Close() error {
	err := n.ReadWriteCloser.Close()
	n.env.FileChanged(n.path)
	return err
}

// matchDenied reports which destructive pattern a script matches, if any.
// The unix tool never asks for confirmation, so this denylist is the only
// guard left in front of it.
func matchDenied(script string) string {
	low := strings.ToLower(script)
	for _, d := range deniedPatterns {
		if strings.Contains(low, strings.ToLower(d)) {
			return d
		}
	}
	return ""
}

func builtinNames() []string {
	names := make([]string, 0, len(builtins))
	for n := range builtins {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func RegisterPosix(r *Registry) {
	r.Add(&Tool{
		Name: "unix",
		Description: "Run a POSIX shell script, interpreted natively in Go so it behaves the " +
			"same on Windows, macOS and Linux with no WSL, busybox or Git Bash. Full sh " +
			"syntax: pipelines, && and ||, for/while/if, command substitution, globbing, " +
			"here-documents, variables and redirection. These utilities are built in and " +
			"portable: " + strings.Join(builtinNames(), ", ") + ". Any other command runs " +
			"through the host shell (PowerShell on Windows, sh elsewhere), so builds, " +
			"package managers, git and compilers work in the same script. Returns combined " +
			"stdout and stderr plus the exit code.",
		// Deliberately not gated: this tool never asks for confirmation. Writes
		// are still confined to the workspace and deniedPatterns still applies.
		Mutating: false,
		Schema: obj(map[string]any{
			"command":    str(`A shell script, e.g. "grep -rn TODO src | wc -l" or "go build ./... && echo ok".`),
			"cwd":        str("Working directory relative to the workspace root. Optional."),
			"timeout_ms": num("Timeout in milliseconds. Default 120000, maximum 600000."),
		}, "command"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Command   string `json:"command"`
				Cwd       string `json:"cwd"`
				TimeoutMS int    `json:"timeout_ms"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if strings.TrimSpace(a.Command) == "" {
				return Errf("command is empty")
			}
			if d := matchDenied(a.Command); d != "" {
				return Errf("refusing to run a script matching the destructive pattern %q", d)
			}

			dir := env.realRoot()
			if a.Cwd != "" {
				var err error
				if dir, err = env.Resolve(a.Cwd); err != nil {
					return Errf("%v", err)
				}
			}

			// A shell can loop forever, and this tool can spawn real processes,
			// so it needs the same deadline run_shell has.
			timeout := 120 * time.Second
			if a.TimeoutMS > 0 {
				timeout = time.Duration(a.TimeoutMS) * time.Millisecond
			}
			if timeout > 10*time.Minute {
				timeout = 10 * time.Minute
			}
			cctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()

			start := time.Now()
			out, code, err := runScript(cctx, env, dir, a.Command)
			elapsed := time.Since(start).Round(time.Millisecond)

			if cctx.Err() == context.DeadlineExceeded {
				return Result{
					Output:  fmt.Sprintf("Script timed out after %s.\n\n%s", timeout, clamp(out, 30000)),
					IsError: true,
				}
			}
			if err != nil {
				if strings.TrimSpace(out) != "" {
					return Result{Output: clamp(out, 60000) + "\n" + err.Error(), IsError: true}
				}
				return Errf("%v", err)
			}

			header := fmt.Sprintf("exit=%d elapsed=%s cwd=%s", code, elapsed, env.Rel(dir))
			body := clamp(out, 60000)
			if strings.TrimSpace(body) == "" {
				body = "(no output)"
			}
			return Result{
				Output:  header + "\n" + body,
				IsError: code != 0,
				Meta:    map[string]any{"exitCode": int(code), "elapsedMs": elapsed.Milliseconds()},
			}
		},
	})
}
