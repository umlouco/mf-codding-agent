package tools

import "testing"

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
