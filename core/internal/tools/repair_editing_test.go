package tools

import (
	"encoding/json"
	"testing"
)

func TestRepairCanEditEveryProjectFileType(t *testing.T) {
	env := &Env{Root: t.TempDir(), QueueRole: "supervisor-repair"}
	for _, file := range []string{"internal/config/config.go", "internal/config/config_test.go", "parnassus.config.json", "README.md", "settings.ini", ".env", "frontend/Panel.vue"} {
		input, _ := json.Marshal(map[string]string{"file_path": file, "old_string": "old", "new_string": "new"})
		if err := env.CheckQueueOwnership("Edit", input, true); err != nil {
			t.Errorf("repair cannot edit %s: %v", file, err)
		}
	}
	if err := env.CheckQueueCommand(`Set-Content parnassus.config.json -Value '{}'`); err != nil {
		t.Errorf("repair shell cannot edit config: %v", err)
	}
	if env.CheckQueueWritePath(".mfagent/queue.db") == nil {
		t.Error("repair may directly mutate queue storage")
	}
}
