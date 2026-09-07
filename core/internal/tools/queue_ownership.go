package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Autonomous workers cannot mutate the queue through MCP/editor tools. The
// supervisor returns decisions; the extension fences workers and applies them.
func QueueToolAllowed(role, name string) bool {
	if role == "" {
		return true
	}
	name = strings.ToLower(name)
	if strings.Contains(name, "task_queue_") {
		return strings.HasSuffix(name, "task_queue_list") || strings.HasSuffix(name, "task_queue_stats")
	}
	return !strings.Contains(name, "manage_todo") && !strings.Contains(name, "update_task_list") && !strings.Contains(name, "write_todos")
}

func (e *Env) CheckQueueOwnership(name string, input json.RawMessage, mutating bool) error {
	if e.QueueRole == "" {
		return nil
	}
	if !QueueToolAllowed(e.QueueRole, name) {
		return fmt.Errorf("queue ownership: task-list changes belong to supervisor decisions applied by the extension. The executor must follow its assigned task and report blockers")
	}
	var args map[string]any
	if json.Unmarshal(input, &args) != nil {
		return nil
	}
	if command, ok := args["command"].(string); ok {
		return e.CheckQueueCommand(command)
	}
	if !mutating {
		return nil
	}
	if (e.QueueRole == "validator" || e.QueueRole == "supervisor") && !testingBrowserTool(name) {
		return fmt.Errorf("queue ownership: %s may inspect files and run checks but cannot use a writing tool; request a supervisor test-repair decision for test changes", e.QueueRole)
	}
	var inspect func(any) error
	inspect = func(value any) error {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				switch key {
				case "path", "file_path", "filePath", "uri", "source", "destination", "old_path", "new_path":
					if path, ok := child.(string); ok {
						if err := e.CheckQueueWritePath(path); err != nil {
							return err
						}
					}
				}
				if err := inspect(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range v {
				if err := inspect(child); err != nil {
					return err
				}
			}
		case string:
			// Patch tools carry their target filenames inside patch text.
			for _, match := range patchTarget.FindAllStringSubmatch(v, -1) {
				if err := e.CheckQueueWritePath(strings.TrimSpace(match[1])); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return inspect(args)
}

var patchTarget = regexp.MustCompile(`(?m)^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$`)

// Check the resolved path too: aliases and symlinks must not change ownership.
func (e *Env) CheckQueueWritePath(path string) error {
	if e.QueueRole == "" {
		return nil
	}
	resolved := path
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(e.Root, resolved)
	}
	resolved = filepath.Clean(resolved)
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		resolved = real
	}
	normalized := strings.ToLower(strings.ReplaceAll(resolved, `\`, "/"))
	if strings.Contains(normalized, "/.mfagent/queue.db") {
		return fmt.Errorf("queue ownership: the task database can only be changed by the extension's supervisor decision handler")
	}
	if e.QueueRole == "validator" || e.QueueRole == "supervisor" {
		return fmt.Errorf("queue ownership: %s cannot rewrite workspace files; request supervisor test repair", e.QueueRole)
	}
	if e.QueueRole == "supervisor-repair" && !testPath(normalized) {
		return fmt.Errorf("queue ownership: supervisor test repair cannot rewrite application file %s; return an implementation repair decision", path)
	}
	if e.QueueRole == "executor" && testPath(normalized) {
		if _, err := os.Stat(resolved); err == nil {
			return fmt.Errorf("queue ownership: the supervisor must rewrite existing test %s. Report the defect and request STOP_AND_REWRITE_TESTS", path)
		}
	}
	return nil
}

func testPath(path string) bool {
	path = "/" + strings.ToLower(strings.ReplaceAll(path, `\`, "/"))
	return strings.Contains(path, "/tests/") || strings.Contains(path, "/test/") || strings.Contains(path, "/playwright-tests/") || strings.Contains(path, ".spec.") || strings.Contains(path, ".test.") || strings.Contains(path, "/test_") || strings.Contains(path, "_test.") || strings.Contains(path, "/playwright.config.")
}

func (e *Env) CheckQueueCommand(command string) error {
	if e.QueueRole == "" {
		return nil
	}
	lower := strings.ToLower(strings.ReplaceAll(command, `\`, "/"))
	if strings.Contains(lower, "queue.db") || strings.Contains(lower, "task_queue_") || strings.Contains(lower, "mfagent.queue.") {
		return fmt.Errorf("queue ownership: shell access to task-list storage is disabled for autonomous workers; use read-only queue tools or return a supervisor decision")
	}
	if e.QueueRole == "validator" || e.QueueRole == "supervisor" || e.QueueRole == "supervisor-repair" {
		// Editing roles use scoped file tools; a shell is for checks and reads.
		// Reject common inline writers rather than allowing an opaque script to
		// rewrite the files whose independent evidence is being collected.
		if queueShellWrite.MatchString(lower) {
			return fmt.Errorf("queue ownership: this %s shell may run checks, but file rewrites require the supervisor's scoped editing tools", e.QueueRole)
		}
	}
	if e.QueueRole == "executor" && testPath(strings.ReplaceAll(lower, " ", "/")) {
		for _, write := range []string{">", "sed ", "perl ", "writefile", "write-file", "set-content", "add-content", "out-file", "apply_patch", "python ", "python3 ", "node -e", "remove-item", "move-item", "rm ", "mv ", "cp ", "tee "} {
			if strings.Contains(lower, write) {
				return fmt.Errorf("queue ownership: the supervisor owns test rewrites. Run the assigned check without modifying its test, or request supervisor test repair")
			}
		}
	}
	return nil
}

var queueShellWrite = regexp.MustCompile(`(?i)(?:\b(?:sed\s+-i|perl\s+-(?:\w*i|e)|(?:python\S*|node|ruby)\s+(?:-c|-e|--eval)|(?:set-content|add-content|out-file|remove-item|move-item|copy-item|rm|mv|cp|tee|touch|truncate|apply_patch)\s)|\b(?:writefile|write_text|write_bytes)\b|\bgit\s+(?:checkout|restore|reset|clean|apply)\b)`)
