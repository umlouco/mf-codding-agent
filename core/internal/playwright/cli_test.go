package playwright

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCLIArgumentsAndExitCode(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}
	home := t.TempDir()
	t.Setenv("MFAGENT_PLAYWRIGHT_HOME", home)
	pkg := filepath.Join(home, "cli", "node_modules", "@playwright", "cli")
	if err := os.MkdirAll(pkg, 0755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(pkg, "playwright-cli.js"), `console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;`)
	args := []string{"run-code", `async page => { await page.goto("https://example.invalid/?a=1&b=2"); return '$value'; }`}
	out, code, err := RunCLI(context.Background(), t.TempDir(), args, time.Second*10)
	if err == nil || code != 7 {
		t.Fatalf("failed command became success: code=%d err=%v output=%s", code, err, out)
	}
	var got []string
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("arguments changed in transit: %#v", got)
	}
}

func TestCLISkillReferencesAndMissingRuntime(t *testing.T) {
	t.Setenv("MFAGENT_PLAYWRIGHT_HOME", "")
	if _, err := ReadCLISkill(""); err == nil {
		t.Fatal("missing CLI reported ready")
	}
	home := t.TempDir()
	t.Setenv("MFAGENT_PLAYWRIGHT_HOME", home)
	pkg := filepath.Join(home, "cli", "node_modules", "@playwright", "cli")
	skill := filepath.Join(home, "cli", ".claude", "skills", "playwright-cli")
	for _, dir := range []string{pkg, filepath.Join(skill, "references")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(pkg, "playwright-cli.js"), "// fixture")
	write(t, filepath.Join(skill, "SKILL.md"), "official skill")
	write(t, filepath.Join(skill, "references", "commands.md"), "reference commands")
	for ref, expected := range map[string]string{"": "official", "references/commands.md": "reference"} {
		if content, err := ReadCLISkill(ref); err != nil || !strings.Contains(content, expected) {
			t.Fatalf("ref %q: %s %v", ref, content, err)
		}
	}
	for _, ref := range []string{"../package.json", "references/../../package.json", "/etc/passwd", "C:/private.md", "references/../../../SKILL.md"} {
		if _, err := ReadCLISkill(ref); err == nil {
			t.Errorf("reference escaped bundled docs: %q", ref)
		}
	}
}
