package tools

import "testing"

func TestTestWriteTargetDistinguishesExecutionFromRewrite(t *testing.T) {
	cases := []struct {
		name    string
		command string
		want    string
	}{
		// Running the suite while writing an unrelated scratch file is not a rewrite.
		{"run suite plus scratch redirect",
			`node test/run.js; Remove-Item .mfagent/scratch/o.txt -ErrorAction SilentlyContinue`,
			""},
		{"run suite with redirect to scratch",
			`node test/run.js > .mfagent/scratch/o.txt`,
			""},
		{"run suite piped to tee scratch",
			`node test/run.js | tee .mfagent/scratch/o.txt`,
			""},
		// A real rewrite of a test is still caught.
		{"redirect into a test",
			`echo x > test/foo.test.js`,
			"test/foo.test.js"},
		{"set-content a test",
			`Set-Content -Path test/foo.test.js -Value x`,
			"test/foo.test.js"},
		{"remove-item a test",
			`Remove-Item tests/foo.test.js`,
			"tests/foo.test.js"},
		{"rm a test",
			`rm tests/foo.test.js`,
			"tests/foo.test.js"},
		{"sed in place a test",
			`sed -i s/a/b/ tests/foo.test.js`,
			"tests/foo.test.js"},
		{"tee into a test",
			`node build.js | tee tests/out.test.js`,
			"tests/out.test.js"},
		// Inline scripts defeat static reading and stay pessimistic.
		{"node eval writes a test",
			`node -e "require('fs').writeFileSync('test/x.test.js','')"`,
			"test/x.test.js"},
		{"python writes a test",
			`python -c "open('tests/x.test.js','w')"`,
			"tests/x.test.js"},
		{"git restore a test",
			`git checkout -- test/x.test.js`,
			"test/x.test.js"},
		// Package managers install dependencies, whatever their arguments name.
		{"npm install playwright test package",
			`npm install -D @playwright/test > .mfagent/scratch/npm.log`,
			""},
		{"plain read",
			`grep -n assertion test/foo.test.js`,
			""},
	}
	for _, tc := range cases {
		if got := testWriteTarget(tc.command); got != tc.want {
			t.Errorf("%s:\n  command %q\n  got %q, want %q", tc.name, tc.command, got, tc.want)
		}
	}
}

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
