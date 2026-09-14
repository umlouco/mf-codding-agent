package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestExecutorOwnsImplementationTestsAndConfig(t *testing.T) {
	root := t.TempDir()
	env := &Env{Root: root, QueueRole: "executor"}
	for _, path := range []string{"internal/config/config.go", "internal/config/config_test.go", "parnassus.config.json"} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("existing content"), 0600); err != nil {
			t.Fatal(err)
		}
		for _, target := range []string{path, full} {
			input, _ := json.Marshal(map[string]string{"file_path": target, "old_string": "existing", "new_string": "updated"})
			if err := env.CheckQueueOwnership("Edit", input, true); err != nil {
				t.Errorf("Edit %s: %v", target, err)
			}
		}
	}
	for _, command := range []string{`go test ./internal/config/...`, `Set-Content internal/config/config_test.go -Value 'test content'`} {
		if err := env.CheckQueueCommand(command); err != nil {
			t.Errorf("executor command: %v", err)
		}
	}
}

func TestExecutorOwnershipRetainsOtherRoleBoundaries(t *testing.T) {
	for _, role := range []string{"executor", "supervisor-repair", "supervisor", "validator"} {
		env := &Env{Root: t.TempDir(), QueueRole: role}
		if env.CheckQueueWritePath(".mfagent/queue.db") == nil {
			t.Errorf("%s may write queue", role)
		}
		if env.CheckQueueCommand("sqlite3 .mfagent/queue.db 'delete from tasks'") == nil {
			t.Errorf("%s may mutate queue from shell", role)
		}
		if role != "executor" && env.CheckQueueWritePath("parnassus.config.json") == nil {
			t.Errorf("%s may edit application config", role)
		}
		if (role == "validator" || role == "supervisor") && env.CheckQueueWritePath("config_test.go") == nil {
			t.Errorf("%s may edit tests", role)
		}
	}
}
