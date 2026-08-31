package tools

// A POSIX shell that behaves identically on Windows, macOS and Linux.
//
// Shell syntax — pipelines, && and ||, for/while/if, command substitution,
// globbing, here-documents, variables and redirection — comes from mvdan.cc/sh,
// a parser and interpreter written in Go, so the syntax means the same thing on
// every platform with no busybox, WSL or Git Bash installed.
//
// The utilities themselves (grep, sed, awk, …) are the Go builtins in posix.go
// and posixutil.go, except where the host has a real implementation worth
// deferring to — see hostPreferred.
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

/*
hostPreferred lists the builtins that should defer to the host's own
implementation whenever the host has one.

The builtins exist so that a script means the same thing on a Windows machine
with no WSL or Git Bash as it does anywhere else. On Linux and macOS that trade
runs backwards: the real utilities are already installed and complete, while
these reimplementations cover only the flags that have been needed so far. The
Go sed does substitution and nothing else, so on a Linux host `sed -n '1,50p'`
and `sed -i` fail against a shim standing in front of a working GNU sed — and
the model cannot tell that from sed being broken.

Only read-only utilities are listed. Anything that creates, deletes or rewrites
a file — mkdir, touch, rm, cp, mv, tee — stays in Go on every platform: those
resolve their arguments through Env.Resolve, which confines them to the
workspace, and report what they wrote through Env.FileChanged, and neither
survives being handed to /usr/bin.

What this gives up: a delegated utility does not read through Env.Resolve, so
`cat ../../outside` stops being refused, and a host `sed -i` rewrites a file
without the editor being told. Both are already true of every command that has
no Go implementation at all, which the shell has always run on the host as-is,
so this widens nothing that was not already open. Writes through redirection
stay confined either way — the interpreter's OpenHandler sees those regardless
of which implementation runs the command.
*/
var hostPreferred = map[string]bool{
	"awk": true, "basename": true, "cat": true, "comm": true, "cut": true,
	"diff": true, "dirname": true, "du": true, "find": true, "grep": true,
	"head": true, "ls": true, "nl": true, "paste": true, "rev": true,
	"sed": true, "seq": true, "sort": true, "stat": true, "tail": true,
	"tr": true, "uniq": true, "wc": true, "xargs": true,
}

// hostUtilPath caches the PATH lookup per utility name, holding "" for the ones
// the host does not have. Every stage of every pipeline asks, and PATH does not
// change underneath a running core.
var hostUtilPath sync.Map

// preferHostUtil reports whether args[0] should be run from the host rather
// than from posix.go. Setting MFAGENT_PORTABLE_UTILS forces the builtins
// everywhere, which is how you reproduce Windows behaviour on a Unix box.
func preferHostUtil(name string) bool {
	if runtime.GOOS == "windows" || !hostPreferred[name] {
		return false
	}
	if os.Getenv("MFAGENT_PORTABLE_UTILS") != "" {
		return false
	}
	if v, ok := hostUtilPath.Load(name); ok {
		return v.(string) != ""
	}
	path, err := exec.LookPath(name)
	if err != nil {
		path = ""
	}
	hostUtilPath.Store(name, path)
	return path != ""
}

// dispatch routes a command to its Go implementation when one exists and the
// host has nothing better, and to the host otherwise. It is only reached for
// commands the interpreter does not handle itself — cd, echo, printf, test,
// read and the other shell builtins never arrive here.
func dispatch(env *Env) interp.ExecHandlerFunc {
	var self interp.ExecHandlerFunc
	self = func(ctx context.Context, args []string) error {
		if len(args) == 0 {
			return nil
		}
		hc := interp.HandlerCtx(ctx)
		b, ok := builtins[args[0]]
		if !ok || preferHostUtil(args[0]) {
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
			// A builtin implements a subset of its utility's flags, so a
			// rejected argument is usually a request for something
			// unimplemented rather than a typo. Printing what this one does
			// accept turns a dead end into one retry, and this is the only
			// place the usage string is ever shown.
			var usage usageError
			if errors.As(err, &usage) {
				fmt.Fprintf(hc.Stderr, "%s: %v\nusage: %s\n", args[0], err, b.usage)
				return interp.NewExitStatus(1)
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
// Nothing asks the user before a script runs, so this denylist and the
// workspace confinement in Env.Resolve are the only guards in front of it.
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

// utilitiesBlurb tells the model which utilities a script gets on this host and,
// for the ones answered in Go, which flags they accept.
//
// The builtins cover a subset of each utility that nobody can guess from the
// name — reaching for `sed -n` costs a round to discover that this sed only
// substitutes. Spelling the subset out is close to free here, because the tool
// definitions sit in the cached prefix of every request, and it is only ever
// expensive to learn by trial.
func utilitiesBlurb() string {
	var host, portable []string
	for _, n := range builtinNames() {
		if preferHostUtil(n) {
			host = append(host, n)
			continue
		}
		// The usage string already starts with the command name.
		portable = append(portable, builtins[n].usage)
	}

	var sb strings.Builder
	if len(host) > 0 {
		fmt.Fprintf(&sb, "These run this host's own implementation, with all of their usual flags: %s. ",
			strings.Join(host, ", "))
	}
	if len(portable) > 0 {
		list := strings.Join(portable, "; ")
		// Several usage strings end in "...", which would take a fourth dot.
		end := ". "
		if strings.HasSuffix(list, ".") {
			end = " "
		}
		fmt.Fprintf(&sb, "These are portable Go builtins and accept only what is shown here: %s%s",
			list, end)
	}
	return sb.String()
}

func RegisterPosix(r *Registry) {
	r.Add(&Tool{
		Name: "unix",
		Description: "Run a POSIX shell script. The syntax is interpreted natively in Go and is " +
			"identical on Windows, macOS and Linux with no WSL, busybox or Git Bash: " +
			"pipelines, && and ||, for/while/if, command substitution, globbing, " +
			"here-documents, variables and redirection. " + utilitiesBlurb() +
			"Any other command runs through the host shell (PowerShell on Windows, sh " +
			"elsewhere), so builds, package managers, git and compilers work in the same " +
			"script. Returns combined stdout and stderr plus the exit code. " +
			"It reads and writes the same files every other tool does, through the same " +
			"workspace root. A script that only reads runs immediately; one that writes, " +
			"Reaching for this tool to get around a refusal from read_file or edit_file " +
			"will not work and is not a fix — the refusal will explain what to do instead.",
		// Classified per script rather than per tool, so a read-only pipeline is
		// not serialised behind every build and the chat can say which scripts
		// write — see writeintent.go. Writes stay confined to the workspace and
		// deniedPatterns still applies on top.
		Mutating:  true,
		MutatesOn: unixMutatesOn,
		Summarize: summarizeUnix,
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
