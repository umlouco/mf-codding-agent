package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// instructionFiles are the repo-level instruction conventions worth reading,
// in priority order. AGENTS.md is the closest thing the ecosystem has to a
// standard (Codex, and a growing list of other tools, read it); CLAUDE.md and
// .mfagent/instructions.md cover a project that already wrote one for another
// tool, or for this one specifically. Only the first one found is used —
// concatenating several risks contradictory instructions with no indication
// which one wins.
var instructionFiles = []string{
	"AGENTS.md",
	"CLAUDE.md",
	filepath.Join(".mfagent", "instructions.md"),
}

// maxInstructionBytes bounds how much of the file lands in the system prompt.
// A large instructions file still contributes its first section rather than
// being dropped outright, but it must not crowd out the rest of the prompt.
const maxInstructionBytes = 24000

// LoadProjectInstructions reads the first repo-level instructions file it
// finds under root and formats it for the system prompt. Returns "" when
// none exists or the one found is empty, so callers can splice it in
// unconditionally.
func LoadProjectInstructions(root string) string {
	if root == "" {
		return ""
	}
	for _, name := range instructionFiles {
		raw, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			continue
		}
		text := strings.TrimSpace(string(raw))
		if text == "" {
			continue
		}
		if len(text) > maxInstructionBytes {
			text = text[:maxInstructionBytes] + "\n\n… (truncated)"
		}
		return fmt.Sprintf("# Project instructions (from %s)\n\n%s", filepath.ToSlash(name), text)
	}
	return ""
}
