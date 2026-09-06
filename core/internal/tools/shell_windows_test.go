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

func TestPowerShellCompatiblePreservesHereStringSource(t *testing.T) {
	for _, quote := range []string{"'", "\""} {
		body := "if (first && second) { console.log('yes'); }"
		input := "$code = @" + quote + "\n" + body + "\n" + quote + "@\nWrite-Output $code && Write-Output done"
		got := powerShellCompatible(input)
		if !strings.Contains(got, body) || strings.Count(got, powerShellAndGuard) != 1 {
			t.Fatalf("here-string source corrupted: %q", got)
		}
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

func TestCleanPowerShellOutputPreservesStdoutBesideProgressAndErrors(t *testing.T) {
	progress := `<Objs Version="1.1.0.1"><Obj S="progress"><PR><AV>Loading modules</AV></PR></Obj></Objs>`
	if got := cleanPowerShellOutput("#< CLIXML\r\ncount=1\r\n" + progress); got != "count=1" {
		t.Fatalf("lost command output beside progress XML: %q", got)
	}
	errorXML := `<Objs Version="1.1.0.1"><S S="Error">check failed_x000A_</S></Objs>`
	if got := cleanPowerShellOutput("#< CLIXML\ncount=1\n" + errorXML + "\nafter"); got != "count=1\ncheck failed\nafter" {
		t.Fatalf("lost stdout or error evidence: %q", got)
	}
	if got := cleanPowerShellOutput("#< CLIXML\n" + progress); got != "" {
		t.Fatalf("progress serialization leaked: %q", got)
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

func TestPowerShellErrorsExplainPortableRecovery(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell compatibility")
	}
	r := NewRegistry()
	RegisterShell(r)
	tool, _ := r.Get("run_shell")
	input, _ := json.Marshal(map[string]any{"command": "powershell.exe -NoProfile -NonInteractive -Command \"curl -I http://example.invalid\""})
	result := tool.Run(context.Background(), &Env{Root: t.TempDir()}, input)
	if !result.IsError || !strings.Contains(result.Output, "Use curl.exe") {
		t.Fatalf("missing actionable recovery: %+v", result)
	}
}

func TestRunShellWritesHereStringWithoutRewritingEmbeddedCode(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell compatibility")
	}
	r := NewRegistry()
	RegisterShell(r)
	tool, _ := r.Get("run_shell")
	root := t.TempDir()
	source := "console.log('value && preserved');"
	input, _ := json.Marshal(map[string]any{"command": "$source = @'\n" + source + "\n'@\n[IO.File]::WriteAllText((Join-Path (Get-Location) 'probe.js'), $source) && Write-Output saved"})
	result := tool.Run(context.Background(), &Env{Root: root}, input)
	actual, err := os.ReadFile(filepath.Join(root, "probe.js"))
	if result.IsError || err != nil || strings.TrimSpace(string(actual)) != source {
		t.Fatalf("embedded source changed: result=%+v err=%v", result, err)
	}
}

func TestPortableRecoveryPreservesExistingDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell compatibility")
	}
	r := NewRegistry()
	RegisterShell(r)
	RegisterPosix(r)
	native, _ := r.Get("run_shell")
	portable, _ := r.Get("unix")
	root := t.TempDir()
	env := &Env{Root: root}
	if err := os.Mkdir(filepath.Join(root, "existing"), 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "existing", "keep.txt")
	if err := os.WriteFile(marker, []byte("existing work"), 0644); err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"command":"mkdir -p existing"}`)
	failed := native.Run(context.Background(), env, input)
	if !failed.IsError || !strings.Contains(failed.Output, "unix tool") {
		t.Fatalf("missing recovery: %+v", failed)
	}
	recovered := portable.Run(context.Background(), env, input)
	data, err := os.ReadFile(marker)
	if recovered.IsError || err != nil || string(data) != "existing work" {
		t.Fatalf("unsafe recovery: %+v %v", recovered, err)
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
