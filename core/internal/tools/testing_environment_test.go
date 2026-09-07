package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/config"
)

func TestPlaywrightRunnerChecksExistingSpecTarget(t *testing.T) {
	e := &Env{Root: t.TempDir(), Testing: config.TestingEnvironment{URL: "https://app.example.test/project/"}}
	file := filepath.Join(e.Root, "form.spec.js")
	if err := os.WriteFile(file, []byte(`const {test}=require('@playwright/test'); test('form',async({page})=>page.goto('http://localhost:8000/project/'));`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.CheckTestingCommand("npx playwright test form.spec.js"); err == nil || !strings.Contains(err.Error(), "form.spec.js") {
		t.Fatalf("stale spec was not blocked: %v", err)
	}
	if err := e.CheckTestingCommand("node --check playwright-tests/form.spec.js"); err != nil {
		t.Fatalf("syntax inspection incorrectly launched browser target checks: %v", err)
	}
	if err := os.WriteFile(file, []byte(`const {test}=require('@playwright/test'); test('form',async({page})=>page.goto(process.env.MFAGENT_TEST_URL));`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.CheckTestingCommand("npx playwright test form.spec.js"); err != nil {
		t.Fatal(err)
	}
	// An unrelated unit fixture is not a browser target.
	if err := os.WriteFile(filepath.Join(e.Root, "url.test.js"), []byte(`assert(parse('http://localhost:1234/'));`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.CheckTestingCommand("npm test"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.Root, "unrelated.spec.js"), []byte(`const {test}=require('@playwright/test'); const url='http://localhost:1234/';`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.CheckTestingCommand("npx playwright test form.spec.js --grep navigation"); err != nil {
		t.Fatalf("unselected suite blocked a focused step: %v", err)
	}
	if err := e.CheckTestingCommand("npx playwright test"); err == nil {
		t.Fatal("full suite accepted the stale target")
	}
}

func TestTestingTargetEnforcement(t *testing.T) {
	e := &Env{Root: t.TempDir(), Testing: config.TestingEnvironment{URL: "https://app.example.test/project/"}}
	for _, target := range []string{"http://localhost:8080/", "https://other.example.test/project/", "https://app.example.test/fixture.html"} {
		if e.CheckTestingURL(target, true) == nil {
			t.Fatalf("accepted replacement %s", target)
		}
	}
	if err := e.CheckTestingURL("https://app.example.test:443/project/", true); err != nil {
		t.Fatal(err)
	}
	e.ObserveTestingTool("editor__open_browser_page", json.RawMessage(`{"url":"https://app.example.test/project/"}`))
	if err := e.CheckTestingURL("https://app.example.test/login", true); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"python -m http.server 8080", "php -S 127.0.0.1:8080", "npm run dev", "npx http-server", "curl http://127.0.0.1:9000/"} {
		if e.CheckTestingCommand(command) == nil {
			t.Fatalf("accepted replacement command %s", command)
		}
		if _, _, err := RunScript(context.Background(), e, e.Root, command); err == nil {
			t.Fatalf("direct sh bypassed policy: %s", command)
		}
	}
	for _, command := range []string{"go test ./...", "dcc32 Project.dpr", "npm test", "curl https://app.example.test/project/"} {
		if err := e.CheckTestingCommand(command); err != nil {
			t.Fatal(err)
		}
	}
	e.Testing.URL = "http://127.0.0.1:18780/app/"
	if err := e.CheckTestingCommand("curl http://127.0.0.1:18780/app/"); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalCredentialsWithoutURL(t *testing.T) {
	t.Setenv("MFAGENT_TEST_URL", "")
	t.Setenv("MFAGENT_CREDENTIAL_TOKEN", "old")
	e := &Env{Root: t.TempDir(), Testing: config.TestingEnvironment{Credentials: map[string]string{"token": "supplied-terminal-secret"}}}
	if err := ApplyTestingProcessEnvironment(e.Testing); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("MFAGENT_CREDENTIAL_TOKEN") != "supplied-terminal-secret" {
		t.Fatal("credential not inherited")
	}
	output, code, err := RunScript(context.Background(), e, e.Root, `printf '%s' "$MFAGENT_CREDENTIAL_TOKEN"`)
	if err != nil || code != 0 || output != "supplied-terminal-secret" {
		t.Fatalf("terminal reference failed: code=%d err=%v", code, err)
	}
	if e.CheckTestingCommand("npm start") != nil {
		t.Fatal("terminal project incorrectly requires URL")
	}
	r := NewRegistry()
	RegisterTestingEnvironment(r)
	tool, _ := r.Get("testing_environment")
	result := tool.Run(context.Background(), e, json.RawMessage(`{}`))
	if strings.Contains(result.Output, "supplied-terminal-secret") || !strings.Contains(result.Output, "MFAGENT_CREDENTIAL_TOKEN") {
		t.Fatal("tool must expose references only")
	}
	if e.RedactTestingSecrets(output) != "[REDACTED]" {
		t.Fatal("output not redacted")
	}
}

func TestCredentialInputRedactionPreservesJSON(t *testing.T) {
	e := &Env{Testing: config.TestingEnvironment{Credentials: map[string]string{"password": "a\"b\\c"}}}
	input, _ := json.Marshal(map[string]any{"value": "a\"b\\c", "nested": []string{"a\"b\\c"}})
	result := e.RedactTestingInput(input)
	if !json.Valid(result) || strings.Contains(string(result), "b") || !strings.Contains(string(result), "REDACTED") {
		t.Fatalf("invalid redaction %s", result)
	}
}
