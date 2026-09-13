package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTestingHookExecutorCanEditExistingTests(t *testing.T) {
	t.Setenv("MFAGENT_QUEUE_ROLE", "executor")
	file := filepath.Join(t.TempDir(), "config_test.go")
	if err := os.WriteFile(file, []byte("package config"), 0600); err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"tool_name": "Edit", "tool_input": map[string]string{
		"file_path": file, "old_string": "package config", "new_string": "package config\n// regression test",
	}})
	var stderr bytes.Buffer
	if code := runTestingHook(strings.NewReader(string(input)), &stderr); code != 0 {
		t.Fatalf("PreToolUse:Edit hook exit %d: %s", code, stderr.String())
	}
}

func TestTestingHookRepairCanEditApplicationConfig(t *testing.T) {
	t.Setenv("MFAGENT_QUEUE_ROLE", "supervisor-repair")
	file := filepath.Join(t.TempDir(), "parnassus.config.json")
	if err := os.WriteFile(file, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"tool_name": "Edit", "tool_input": map[string]string{
		"file_path": file, "old_string": "{}", "new_string": "{\"vision\":{}}",
	}})
	var stderr bytes.Buffer
	if code := runTestingHook(strings.NewReader(string(input)), &stderr); code != 0 {
		t.Fatalf("repair PreToolUse:Edit hook exit %d: %s", code, stderr.String())
	}
}
