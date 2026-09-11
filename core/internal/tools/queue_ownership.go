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
		return fmt.Errorf("queue ownership: supervisor test repair cannot rewrite application file %s; stop this repair and request SPLIT into separate implementation and verification tasks while preserving the original owner goal", path)
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
	if e.QueueRole == "executor" {
		if target := testWriteTarget(lower); target != "" {
			return fmt.Errorf("queue ownership: the supervisor owns test rewrites, and this command writes to %s. "+
				"Run the assigned check without modifying its test, or request supervisor test repair", target)
		}
	}
	return nil
}

// packageManagers never rewrite a test, whatever their arguments look like.
// Installing a dependency is dependency management; the fact that a package is
// *named* `@playwright/test` says nothing about which files are being written.
var packageManagers = map[string]bool{
	"npm": true, "npx": true, "pnpm": true, "pnpx": true,
	"yarn": true, "bun": true, "bunx": true, "corepack": true,
}

// testWriteTarget returns the test file a command would write to, or "" when
// it writes to none.
//
// The precision matters more than it looks. The previous version pasted the
// whole command together with "/" for every space and asked whether the result
// contained "/test/", which made `npm install -D @playwright/test > log` read
// as a test rewrite: the package name became a directory segment and the
// redirect became a write verb. An executor that could never install its own
// dependencies had no way to make progress and no way to say why.
func testWriteTarget(command string) string {
	fields := strings.Fields(command)
	// Skip leading `VAR=value` assignments to find the real program.
	for len(fields) > 0 && strings.Contains(fields[0], "=") && !strings.ContainsAny(fields[0], "/\\") {
		fields = fields[1:]
	}
	if len(fields) > 0 {
		program := fields[0]
		if slash := strings.LastIndexAny(program, "/\\"); slash >= 0 {
			program = program[slash+1:]
		}
		if packageManagers[strings.TrimSuffix(program, ".cmd")] {
			return ""
		}
	}
	if !queueShellWrite.MatchString(command) && !strings.Contains(command, ">") {
		return ""
	}
	for _, token := range splitArgs(command) {
		if token == "" || strings.HasPrefix(token, "-") || packageSpecifier(token) {
			continue
		}
		// A path inside node_modules is a dependency, not one of the project's
		// tests — `node node_modules/@playwright/test/cli.js` is how the runner
		// is invoked, not an edit to a spec.
		if strings.Contains(token, "node_modules/") || strings.Contains(token, `node_modules\`) {
			continue
		}
		if testPath(token) {
			return token
		}
	}
	return ""
}

// splitArgs breaks a command into candidate path arguments, cutting on shell
// metacharacters and stripping quotes and redirect operators.
func splitArgs(command string) []string {
	raw := strings.FieldsFunc(command, func(r rune) bool {
		switch r {
		case ' ', '\t', '\n', '\r', '|', ';', '&', '(', ')', '<', '>', '\'', '"', '`':
			return true
		}
		return false
	})
	out := make([]string, 0, len(raw))
	for _, token := range raw {
		out = append(out, strings.Trim(token, ",="))
	}
	return out
}

// packageSpecifier reports whether a token names an npm package rather than a
// path — `@playwright/test`, `@playwright/test@1.55.0`, `mocha@^10`. A real
// path to a test carries more structure than a single scope segment, or is
// anchored with `./`, `/` or a drive letter.
func packageSpecifier(token string) bool {
	if strings.HasPrefix(token, "./") || strings.HasPrefix(token, "../") ||
		strings.HasPrefix(token, "/") || strings.HasPrefix(token, ".\\") {
		return false
	}
	if len(token) > 1 && token[1] == ':' {
		return false // C:\… on Windows
	}
	if !strings.HasPrefix(token, "@") {
		return false
	}
	// A scoped package is exactly `@scope/name`, optionally `@version`.
	return strings.Count(token, "/") == 1
}

var queueShellWrite = regexp.MustCompile(`(?i)(?:\b(?:sed\s+-i|perl\s+-(?:\w*i|e)|(?:python\S*|node|ruby)\s+(?:-c|-e|--eval)|(?:set-content|add-content|out-file|remove-item|move-item|copy-item|rm|mv|cp|tee|touch|truncate|apply_patch)\s)|\b(?:writefile|write_text|write_bytes)\b|\bgit\s+(?:checkout|restore|reset|clean|apply)\b)`)
