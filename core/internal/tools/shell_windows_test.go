package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPowerShellCompatibleRewritesOnlyUnquotedAnd(t *testing.T) {
	input := `cd d:\work && python -c "print('a && b')" && echo done`
	got := powerShellCompatible(input)
	if strings.Count(got, powerShellAndGuard) != 2 {
		t.Fatalf("guard count=%d; command=%q", strings.Count(got, powerShellAndGuard), got)
	}
	if !strings.Contains(got, `"print('a && b')"`) {
		t.Fatalf("quoted && was changed: %q", got)
	}
}

func TestPowerShellCompatibleHonoursBacktickEscape(t *testing.T) {
	got := powerShellCompatible("Write-Output `&& echo done")
	if strings.Contains(got, powerShellAndGuard) {
		t.Fatalf("escaped && was changed: %q", got)
	}
}

func TestCleanPowerShellOutputDecodesCliXml(t *testing.T) {
	input := `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">` +
		`<S S="Error">At line:1 char:26_x000D__x000A_</S>` +
		`<S S="Error">The token '&amp;&amp;' is not valid.</S></Objs>`
	got := cleanPowerShellOutput(input)
	if got != "At line:1 char:26\nThe token '&&' is not valid." {
		t.Fatalf("decoded output=%q", got)
	}
}

func TestCleanPowerShellOutputLeavesPlainTextAlone(t *testing.T) {
	const input = "ordinary compiler error\nline two"
	if got := cleanPowerShellOutput(input); got != input {
		t.Fatalf("output=%q", got)
	}
}

func TestRunShellAcceptsAndChainOnWindowsPowerShell(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell compatibility")
	}
	r := NewRegistry()
	RegisterShell(r)
	tool, _ := r.Get("run_shell")
	input, _ := json.Marshal(map[string]any{
		"command": "Write-Output first && Write-Output second",
	})
	result := tool.Run(context.Background(), &Env{Root: t.TempDir()}, input)
	if result.IsError || !strings.Contains(result.Output, "first") || !strings.Contains(result.Output, "second") {
		t.Fatalf("result=%+v", result)
	}
}

func TestRunShellAndChainStopsAfterFailure(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell compatibility")
	}
	r := NewRegistry()
	RegisterShell(r)
	tool, _ := r.Get("run_shell")
	root := t.TempDir()
	input, _ := json.Marshal(map[string]any{
		"command": "Write-Error nope && Set-Content -Path marker.txt -Value should-not-run",
	})
	result := tool.Run(context.Background(), &Env{Root: root}, input)
	_, statErr := os.Stat(filepath.Join(root, "marker.txt"))
	if !result.IsError || !os.IsNotExist(statErr) || strings.Contains(result.Output, "<Objs") {
		t.Fatalf("result=%+v", result)
	}
}
