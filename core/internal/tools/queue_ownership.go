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
	if (e.QueueRole == "validator" || e.QueueRole == "supervisor") && !testingBrowserTool(name) && !cleanupTool(name) {
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

// cleanupTool reports whether a mutating tool only releases resources a run
// owns — stopping or listing the background processes it started. Refusing
// these left dev servers listening on a task's port and polluted later checks,
// so verification may always clean up after itself.
func cleanupTool(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, "shell_kill_background") || strings.HasSuffix(n, "shell_list_background")
}

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
		// Reject commands that actually rewrite files, but allow read-only probes
		// — including a plain `node -e "import(...)..."` inspection, which is not
		// a rewrite just because it names an interpreter inline.
		if validatorShellWrites(command) {
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
// redirect became a write verb. A later version kept that shape and treated
// every `test/...` token as a write target as soon as the command contained any
// writing verb or redirect — so `node test/run.js; Remove-Item scratch/o.txt`
// read as an edit to `test/run.js`, and an executor running the assigned suite
// was cut off for a rewrite it never attempted.
//
// So the question is not "does this command contain a test path" but "is a test
// path the thing this command writes". Only redirect destinations and the
// argument tail of a real writing verb are candidates. Inline scripts
// (`node -e`, `python -c`, `apply_patch`) and VCS restores can write anywhere
// and are unreadable statically, so those stay pessimistic: any test path in
// them counts as a target.
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

	candidates, opaque := writeCandidates(command)
	if opaque {
		// An inline script can write to any path; keep the pessimistic scan so
		// a one-liner cannot hide a test rewrite behind an unknown argument.
		for _, token := range splitArgs(command) {
			if token == "" || strings.HasPrefix(token, "-") || packageSpecifier(token) {
				continue
			}
			if strings.Contains(token, "node_modules/") || strings.Contains(token, `node_modules\`) {
				continue
			}
			if testPath(token) {
				return token
			}
		}
		return ""
	}
	for _, token := range candidates {
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

// writingVerbRe captures a writing verb together with its argument tail, up to
// the next shell separator. The tail is tokenized to find the path operands.
var writingVerbRe = regexp.MustCompile(`(?i)\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|tee|touch|truncate|rmdir|rm|del|cp|mv)\b([^\n;|&<>]*)`)

// sedRe captures sed's arguments; sed only writes with an in-place flag.
var sedRe = regexp.MustCompile(`(?i)\bsed\b([^\n;|&<>]*)`)
var sedInPlaceRe = regexp.MustCompile(`(?i)(?:^|\s)(?:-i|--in-place)(?:\s|$|\.)`)

// opaqueWriterRe matches commands whose write targets cannot be read
// statically: inline interpreters, patch tools and VCS restores.
var opaqueWriterRe = regexp.MustCompile(`(?i)(?:\b(?:python\S*|node|ruby|perl)\s+(?:-c|-e|--eval)\b|\b(?:apply_patch|writefile|write_text|write_bytes)\b|\bgit\s+(?:checkout|restore|reset|clean|apply)\b|(?:^|[;&|]\s*)(?:powershell|pwsh)\b[^\n]*-command\b)`)

// writeCandidates returns the paths a command plausibly writes to, plus
// whether the command contains an opaque writer that defeats static reading.
func writeCandidates(command string) (paths []string, opaque bool) {
	paths = append(paths, verbWriteTargets(command)...)
	paths = append(paths, redirectWriteTargets(command)...)
	return paths, opaqueWriterRe.MatchString(command)
}

// writingVerbAtRe matches one writing verb at the start of a scan position.
var writingVerbAtRe = regexp.MustCompile(`(?i)^(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|tee|touch|truncate|rmdir|rm|del|cp|mv|sed)\b`)

// verbWriteTargets returns the path operands of writing verbs that appear
// outside quotes. Scanning quote-aware, rather than stripping quotes first,
// keeps a quoted target (`Set-Content -Path "test/x"`) visible while a verb
// merely mentioned inside a script string is ignored.
func verbWriteTargets(s string) []string {
	var paths []string
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case '\'', '"':
			quote := c
			i++
			for i < len(s) && s[i] != quote {
				if quote == '"' && s[i] == '\\' && i+1 < len(s) {
					i++
				}
				i++
			}
			i++
			continue
		}
		boundary := i == 0 || !isWordChar(s[i-1])
		if boundary {
			if loc := writingVerbAtRe.FindStringIndex(s[i:]); loc != nil {
				verb := strings.ToLower(s[i : i+loc[1]])
				verbEnd := i + loc[1]
				j := verbEnd
				for j < len(s) && !strings.ContainsRune("\n;|&<>", rune(s[j])) {
					j++
				}
				tail := s[verbEnd:j]
				// sed only writes with an in-place flag.
				if verb != "sed" || sedInPlaceRe.MatchString(tail) {
					paths = append(paths, splitArgs(tail)...)
				}
				i = j
				continue
			}
		}
		i++
	}
	return paths
}

func isWordChar(c byte) bool {
	return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// redirectWriteTargets returns the destinations of unquoted `>`/`>>`/`>|`
// redirections. A `>` inside quotes is script text, and `=>`/`>=`/`2>&1` name
// no file, so a read-only probe that compares values does not look like a write.
func redirectWriteTargets(s string) []string {
	var targets []string
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case '\'', '"':
			quote := c
			i++
			for i < len(s) && s[i] != quote {
				if quote == '"' && s[i] == '\\' && i+1 < len(s) {
					i++
				}
				i++
			}
			i++
		case '>':
			if i > 0 && s[i-1] == '=' { // `=>`
				i++
				continue
			}
			j := i + 1
			if j < len(s) && (s[j] == '>' || s[j] == '|') {
				j++
			}
			for j < len(s) && (s[j] == ' ' || s[j] == '\t') {
				j++
			}
			if j < len(s) && (s[j] == '\'' || s[j] == '"') {
				quote := s[j]
				k := j + 1
				for k < len(s) && s[k] != quote {
					if quote == '"' && s[k] == '\\' && k+1 < len(s) {
						k++
					}
					k++
				}
				if target := s[j+1 : k]; target != "" && !isNullDevice(target) {
					targets = append(targets, target)
				}
				i = k + 1
				continue
			}
			k := j
			for k < len(s) && !strings.ContainsRune(" \t\n;|&<>()", rune(s[k])) {
				k++
			}
			target := s[j:k]
			// `2>&1` duplicates a descriptor; `>=` compares.
			if target != "" && !strings.HasPrefix(target, "&") && !strings.HasPrefix(target, "=") && !isNullDevice(target) {
				targets = append(targets, target)
			}
			i = k
		default:
			i++
		}
	}
	return targets
}

// isNullDevice reports whether a redirection discards output. Writing to the
// null device cannot rewrite a workspace file, so a check like `... 2>/dev/null`
// must not read as an edit.
func isNullDevice(path string) bool {
	switch strings.ToLower(strings.TrimSpace(path)) {
	case "/dev/null", "nul", "nul:", "$null":
		return true
	}
	return false
}

// gitRestoreRe matches history commands that can overwrite working files.
var gitRestoreRe = regexp.MustCompile(`(?i)\bgit\s+(?:checkout|restore|reset|clean|apply)\b`)

// inlineWriteRe matches the write operations an inline interpreter script can
// perform. A validator probe that only reads — `node -e "import('x')"` — must
// not be refused just because it names an interpreter inline.
var inlineWriteRe = regexp.MustCompile(`(?i)(?:writefilesync|appendfilesync|createwritestream|fs\.write|writefile|write_text|write_bytes|truncate|rename|unlink|rmdir|mkdir)|open\([^)]*['"][wa]`)

// validatorShellWrites reports whether a validator/supervisor shell command can
// rewrite a file. It is deliberately narrower than queueShellWrite: the editing
// roles may run read-only probes, so an inline interpreter is only refused when
// its script actually writes, and a redirect only when it has a real target.
func validatorShellWrites(command string) bool {
	paths, opaque := writeCandidates(command)
	if !opaque {
		// A recognised writer with a real target, or sed -i, is a rewrite.
		return len(paths) > 0
	}
	// Opaque inline script or VCS command: refuse when it writes.
	if gitRestoreRe.MatchString(command) {
		return true
	}
	return inlineWriteRe.MatchString(strings.ToLower(command))
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
