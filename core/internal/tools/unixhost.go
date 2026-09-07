package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"mvdan.cc/sh/v3/interp"
)

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
	if path, ok := resolveProgram(dir, args[0]); ok {
		if !needsShell(path) {
			return exec.CommandContext(ctx, path, args[1:]...), func() {}, false
		}
		// Resolution is part of this invocation. Do not discard it and let
		// PowerShell choose a different same-name script from PATH (for
		// example a .ps1 instead of the .cmd selected through PATHEXT).
		args = append([]string{path}, args[1:]...)
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
	// Package-manager shims can mix a native compiler's plain stderr with
	// PowerShell progress records. The shared decoder preserves both plain
	// text and serialized errors, including XML after ordinary output.
	out := cleanPowerShellOutput(s)
	if out != "" && out != s {
		return out + "\n"
	}
	return out
}

// hostCommandLine re-quotes an already-tokenised command for the host shell.
// The POSIX parser has stripped the original quoting, so every argument is
// re-wrapped verbatim — doubled ” for PowerShell, '\” for sh — rather than
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
		// PowerShell's own process status collapses a native nonzero exit to
		// 1, and a later successful statement can mask a script invocation
		// error. Capture both results immediately and propagate them explicitly.
		// Terminating PowerShell errors are rendered as ordinary stderr; native
		// tools may still write diagnostics to stderr while exiting successfully.
		return "$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = $null\ntry {\n& " + line +
			"\n$commandSucceeded = $?\n" +
			"if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }\n" +
			"if (-not $commandSucceeded) { exit 1 }\nexit 0\n" +
			"} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }"
	}
	return line
}
