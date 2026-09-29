package tools

import (
	"encoding/json"
	"testing"
)

func TestValidatorShellWritesAllowsReadOnlyProbes(t *testing.T) {
	cases := []struct {
		name    string
		command string
		want    bool
	}{
		{"version probe", `node -v && npm -v`, false},
		{"playwright import probe with arrow fn",
			`node -e "import('playwright').then(()=>console.log('playwright ok')).catch(()=>console.log('no playwright'))"`,
			false},
		{"read-only inspect", `node test/run.js`, false},
		{"grep a file", `grep -n assertion test/foo.test.js`, false},
		{"cat a file", `cat tools/serve.js`, false},
		{"null-device redirect", `curl -s -i http://127.0.0.1:5173/ 2>/dev/null`, false},
		{"null-device command substitution", `C=$(which curl.exe >/dev/null 2>&1 && echo curl.exe || echo curl); $C -s http://127.0.0.1:5173/`, false},
		{"comparison is not a redirect",
			`node --input-type=module -e 'let n=0; if (n >= 5) process.exit(1); console.log("ok");'`,
			false},
		{"port preflight with netstat and taskkill",
			`pid=$(netstat -ano | grep ':5173' | grep -i LISTENING | awk '{print $NF}' | tr -d '\r' | head -1); ` +
				`if test -n "$pid"; then taskkill /PID "$pid" /F; fi`,
			false},
		{"js comparison in quoted inline script",
			`node --input-type=module -e 'if (a > b) process.exit(1); console.log("ok");'`,
			false},
		{"quoted removal target",
			`rm "test/foo.test.js"`,
			true},
		{"set-content quoted test",
			`Set-Content -Path "test/foo.test.js" -Value x`,
			true},
		{"redirect into a quoted test",
			`echo x > "tests/foo.test.js"`,
			true},
		{"inline write", `node -e "require('fs').writeFileSync('test/x.test.js','')"`, true},
		{"python inline write", `python -c "open('tests/x.test.js','w')"`, true},
		{"redirect write", `echo x > test/foo.test.js`, true},
		{"sed in place", `sed -i s/a/b/ tests/foo.test.js`, true},
		{"cp", `cp test/a.js test/b.js`, true},
		{"git restore", `git checkout -- test/x.test.js`, true},
	}
	for _, tc := range cases {
		if got := validatorShellWrites(tc.command); got != tc.want {
			t.Errorf("%s:\n  command %q\n  got %v, want %v", tc.name, tc.command, got, tc.want)
		}
	}
}

func TestCleanupToolsAllowedForVerification(t *testing.T) {
	for _, name := range []string{"shell_kill_background", "mcp__core__shell_kill_background",
		"mcp__core__shell_list_background"} {
		if !cleanupTool(name) {
			t.Errorf("cleanupTool(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"write_file", "edit_file", "run_shell"} {
		if cleanupTool(name) {
			t.Errorf("cleanupTool(%q) = true, want false", name)
		}
	}
}

// The container is not judged by its steps' path arguments; each step is checked as the call it is.
// A read-only sweep (list_dir of the workspace, a database query, a window listing, a status
// command) used to be refused as a "writing tool" because list_dir's path was outside scratch,
// which ended the tester's turn after twelve seconds with no check run.
func TestRunScriptContainerIsCheckedByItsSteps(t *testing.T) {
	env := &Env{Root: t.TempDir(), QueueRole: "validator"}
	sweep := json.RawMessage(`{"steps":[{"tool":"list_dir","args":{"path":"."}},` +
		`{"tool":"mcp__dbisam__dbisam_select","args":{"sql":"SELECT 1"}},` +
		`{"tool":"run_shell","args":{"command":"Get-Item SAC.exe"}}]}`)
	if err := env.CheckQueueOwnership("run_script", sweep, true); err != nil {
		t.Fatalf("validator refused a read-only batch: %v", err)
	}
	// The steps themselves are still held to the role: a direct write is refused, a scratch write is not.
	if err := env.CheckQueueOwnership("write_file", json.RawMessage(`{"path":"main.go"}`), true); err == nil {
		t.Fatal("a writing step must still be refused when it is checked as its own call")
	}
	scratch := json.RawMessage(`{"path":".mfagent/scratch/helper.ps1"}`)
	if err := env.CheckQueueOwnership("write_file", scratch, true); err != nil {
		t.Fatalf("validator refused a helper script under scratch: %v", err)
	}
}

// A validator's MCP read must not be mistaken for a workspace writing tool.
// Registering MCP tools as Mutating (their external side effects are unknown)
// used to refuse mcp__jira__get_issue with a queue-ownership error, which the
// core treats as a fixed-target rejection and hard-stops the whole turn.
func TestValidatorMayCallMCPTools(t *testing.T) {
	env := &Env{Root: t.TempDir(), QueueRole: "validator"}
	input := json.RawMessage(`{"issue_key":"WEB-1"}`)
	if err := env.CheckQueueOwnership("mcp__jira__get_issue", input, true); err != nil {
		t.Fatalf("validator refused an MCP read: %v", err)
	}
	if err := env.CheckQueueOwnership("mcp__connexall-confluence__get_page", input, true); err != nil {
		t.Fatalf("validator refused an MCP read: %v", err)
	}
	if err := env.CheckQueueOwnership("write_file", json.RawMessage(`{"path":"main.go"}`), true); err == nil {
		t.Fatal("validator may use a workspace writing tool")
	}
}
