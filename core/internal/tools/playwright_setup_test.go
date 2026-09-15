package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlaywrightSuiteDirectory(t *testing.T) {
	t.Setenv("MFAGENT_PLAYWRIGHT_ROOT", "")
	root := t.TempDir()
	suite := filepath.Join(root, "tests", "e2e")
	pkg := filepath.Join(suite, "node_modules", "@playwright", "test")
	if err := os.MkdirAll(pkg, 0755); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{filepath.Join(pkg, "package.json"): `{"version":"suite-pinned"}`, filepath.Join(pkg, "cli.js"): "// fixture", filepath.Join(suite, "playwright.config.js"): "// fixture"} {
		if err := os.WriteFile(name, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	r := NewRegistry()
	RegisterPlaywright(r)
	tool, _ := r.Get("playwright_status")
	result := tool.Run(context.Background(), &Env{Root: root}, json.RawMessage(`{"cwd":"tests/e2e"}`))
	if result.IsError || !strings.Contains(result.Output, "suite-pinned") {
		t.Fatalf("wrong suite runtime: %+v", result)
	}
	setup, err := playwrightSetup(&Env{Root: root}, json.RawMessage(`{"cwd":"tests/e2e"}`))
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.Stat(setup.Root)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(suite)
	if err != nil || !os.SameFile(actual, expected) {
		t.Fatalf("selected wrong suite: %s", setup.Root)
	}
	if _, err := playwrightSetup(&Env{Root: root}, json.RawMessage(`{"cwd":"../outside"}`)); err == nil {
		t.Fatal("suite path escaped workspace")
	}
	auto, err := playwrightSetup(&Env{Root: root}, json.RawMessage(`{}`))
	if err != nil || auto.Root != setup.Root {
		t.Fatalf("mandatory check did not select nested suite: %+v %v", auto, err)
	}
	if err := os.MkdirAll(filepath.Join(root, "e2e"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "e2e", "playwright.config.js"), []byte("// second suite"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := playwrightSetup(&Env{Root: root}, json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "multiple Playwright suites") {
		t.Fatalf("ambiguous suite silently selected: %v", err)
	}
	if _, err := playwrightSetup(&Env{Root: root}, json.RawMessage(`{"cwd":"tests/e2e"}`)); err != nil {
		t.Fatal(err)
	}
}
