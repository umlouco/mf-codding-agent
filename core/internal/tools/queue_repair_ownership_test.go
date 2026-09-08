package tools

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSupervisorRepairRejectsApplicationEditsAndRequestsReplacement(t *testing.T) {
	e := &Env{Root: t.TempDir(), QueueRole: "supervisor-repair"}
	for _, path := range []string{
		"frontend/src/components/tabs/PerfTestTab.vue",
		"lib/server/InvoiceController.ts",
		"src/service.go",
	} {
		input, _ := json.Marshal(map[string]string{"path": path, "old_string": "before", "new_string": "after"})
		err := e.CheckQueueOwnership("edit_file", input, true)
		if err == nil {
			t.Fatalf("supervisor repair may not rewrite application file %s", path)
		}
		for _, required := range []string{"queue ownership:", path, "request SPLIT", "original owner goal"} {
			if !strings.Contains(err.Error(), required) {
				t.Fatalf("missing %q in actionable ownership rejection: %s", required, err)
			}
		}
	}
}

func TestSupervisorRepairStillAllowsScopedTestEdits(t *testing.T) {
	e := &Env{Root: t.TempDir(), QueueRole: "supervisor-repair"}
	for _, path := range []string{"tests/dashboard.ts", "frontend/src/form.spec.ts", "internal/server_test.go"} {
		input, _ := json.Marshal(map[string]string{"path": path, "old_string": "broken fixture", "new_string": "correct fixture"})
		if err := e.CheckQueueOwnership("edit_file", input, true); err != nil {
			t.Fatalf("legitimate test repair for %s rejected: %s", path, err)
		}
	}
}
