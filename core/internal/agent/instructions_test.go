package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadProjectInstructionsPrefersAgentsMd(t *testing.T) {
	root := t.TempDir()
	write(t, root, "AGENTS.md", "Use tabs, not spaces.")
	write(t, root, "CLAUDE.md", "Use spaces, not tabs.")

	got := LoadProjectInstructions(root)
	if !strings.Contains(got, "Use tabs, not spaces.") {
		t.Fatalf("expected AGENTS.md content, got %q", got)
	}
	if strings.Contains(got, "Use spaces") {
		t.Fatalf("did not expect CLAUDE.md content when AGENTS.md exists: %q", got)
	}
}

func TestLoadProjectInstructionsFallsBackToClaudeMd(t *testing.T) {
	root := t.TempDir()
	write(t, root, "CLAUDE.md", "Prefer composition over inheritance.")

	got := LoadProjectInstructions(root)
	if !strings.Contains(got, "Prefer composition over inheritance.") {
		t.Fatalf("expected CLAUDE.md content, got %q", got)
	}
}

func TestLoadProjectInstructionsFallsBackToMfagentDir(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".mfagent"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, root, filepath.Join(".mfagent", "instructions.md"), "Ship small diffs.")

	got := LoadProjectInstructions(root)
	if !strings.Contains(got, "Ship small diffs.") {
		t.Fatalf("expected .mfagent/instructions.md content, got %q", got)
	}
}

func TestLoadProjectInstructionsNoneFound(t *testing.T) {
	root := t.TempDir()
	if got := LoadProjectInstructions(root); got != "" {
		t.Fatalf("expected empty result with no instructions file, got %q", got)
	}
}

func TestLoadProjectInstructionsTruncatesLargeFiles(t *testing.T) {
	root := t.TempDir()
	write(t, root, "AGENTS.md", strings.Repeat("x", maxInstructionBytes+5000))

	got := LoadProjectInstructions(root)
	if len(got) > maxInstructionBytes+1000 {
		t.Fatalf("expected truncated output, got %d bytes", len(got))
	}
	if !strings.Contains(got, "truncated") {
		t.Fatalf("expected a truncation notice, got %q", got[len(got)-50:])
	}
}

func write(t *testing.T, root, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
