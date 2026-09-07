package tools

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func windowsHostFixture(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("Windows script dispatch")
	}
	root := filepath.Join(t.TempDir(), "script directory's space")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
	return root
}

func writeHostFixture(t *testing.T, root, name, body string) string {
	t.Helper()
	file := filepath.Join(root, name)
	if err := os.WriteFile(file, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestHostCommandPreservesResolvedScriptInsteadOfPowerShellLookup(t *testing.T) {
	root := windowsHostFixture(t)
	writeHostFixture(t, root, "mf-route-check.cmd", "@echo off\r\necho selected-cmd\r\necho first=[%~1]\r\necho second=[%~2]\r\nexit /b 0\r\n")
	writeHostFixture(t, root, "mf-route-check.ps1", "param(\n")
	resolved, ok := resolveProgram(root, "mf-route-check")
	if !ok || !strings.EqualFold(filepath.Ext(resolved), ".cmd") {
		t.Fatalf("lookup = %q, %v", resolved, ok)
	}
	args := []string{"argument with spaces", "literal $dollar and apostrophe's"}
	var command strings.Builder
	command.WriteString("mf-route-check")
	for _, arg := range args {
		command.WriteString(" '" + strings.ReplaceAll(arg, "'", "'\"'\"'") + "'")
	}
	output, code, err := RunScript(context.Background(), &Env{Root: root}, root, command.String())
	if err != nil || code != 0 || !strings.Contains(output, "selected-cmd") {
		t.Fatalf("resolved shim not executed: code=%d err=%v output=%s", code, err, output)
	}
	for _, arg := range args {
		if !strings.Contains(output, "["+arg+"]") {
			t.Errorf("argument %q did not survive: %s", arg, output)
		}
	}
}

func TestHostPowerShellParserFailureCannotReturnExitZero(t *testing.T) {
	root := windowsHostFixture(t)
	writeHostFixture(t, root, "invalid.ps1", "param(\n")
	output, code, err := RunScript(context.Background(), &Env{Root: root}, root, "./invalid.ps1")
	if err != nil {
		t.Fatal(err)
	}
	if code == 0 {
		t.Fatalf("parser failure became success: %s", output)
	}
	if !strings.Contains(strings.ToLower(output), "missing") {
		t.Fatalf("parser diagnostic lost: %s", output)
	}
	writeHostFixture(t, root, "wrapper.ps1", "& \"$PSScriptRoot\\invalid.ps1\"\nWrite-Output 'must not mask the failure'\n")
	output, code, err = RunScript(context.Background(), &Env{Root: root}, root, "./wrapper.ps1")
	if err != nil || code == 0 || strings.Contains(output, "must not mask the failure") {
		t.Fatalf("a later statement hid the parser error: code=%d err=%v output=%s", code, err, output)
	}
}

func TestHostBatchExitCodeAndPowerShellSuccessArePreserved(t *testing.T) {
	root := windowsHostFixture(t)
	writeHostFixture(t, root, "nonzero.cmd", "@echo off\r\nexit /b 7\r\n")
	writeHostFixture(t, root, "diagnostic.cmd", "@echo off\r\necho diagnostic-only 1>&2\r\nexit /b 0\r\n")
	for _, tc := range []struct {
		command string
		code    uint8
	}{
		{"./nonzero.cmd", 7},
		{"./diagnostic.cmd", 0},
		{"Write-Output 'host cmdlet succeeded'", 0},
		{"Missing-MfHostCommand", 1},
	} {
		output, code, err := RunScript(context.Background(), &Env{Root: root}, root, tc.command)
		if err != nil || code != tc.code {
			t.Errorf("%s: code=%d want=%d err=%v output=%s", tc.command, code, tc.code, err, output)
		}
	}
}
