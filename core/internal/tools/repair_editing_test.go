package tools

import (
	"encoding/json"
	"strings"
	"testing"
)

// A repair turn owns the test surface only. An application edit must be refused
// with an instruction to split, never quietly permitted, or the repair can make
// a failing test pass by changing the product it is supposed to be checking.
func TestRepairEditsTestsButNotApplicationFiles(t *testing.T) {
	env := &Env{Root: t.TempDir(), QueueRole: "supervisor-repair"}
	for _, file := range []string{
		"internal/config/config_test.go", "frontend/Panel.spec.ts", "tests/harness.go", "playwright.config.ts",
	} {
		input, _ := json.Marshal(map[string]string{"file_path": file, "old_string": "old", "new_string": "new"})
		if err := env.CheckQueueOwnership("Edit", input, true); err != nil {
			t.Errorf("repair cannot edit test file %s: %v", file, err)
		}
	}
	for _, file := range []string{
		"internal/config/config.go", "parnassus.config.json", "README.md", "settings.ini", ".env", "frontend/Panel.vue",
	} {
		input, _ := json.Marshal(map[string]string{"file_path": file, "old_string": "old", "new_string": "new"})
		err := env.CheckQueueOwnership("Edit", input, true)
		if err == nil {
			t.Errorf("repair may edit application file %s", file)
			continue
		}
		if !strings.Contains(err.Error(), "SPLIT_TASK") {
			t.Errorf("repair refusal for %s does not request a split: %v", file, err)
		}
	}
	if err := env.CheckQueueCommand(`Set-Content parnassus.config.json -Value '{}'`); err == nil {
		t.Error("repair shell may rewrite application configuration")
	}
	if err := env.CheckQueueCommand(`Set-Content internal/config/config_test.go -Value 'x'`); err == nil {
		t.Error("repair shell may rewrite a test outside the scoped editing tools")
	}
	if env.CheckQueueWritePath(".mfagent/queue.db") == nil {
		t.Error("repair may directly mutate queue storage")
	}
}
