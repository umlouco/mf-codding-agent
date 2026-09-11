package tools

import "testing"

// The night this guard cost: an executor could not install its own test
// dependency because the package happened to be named `@playwright/test`.
func TestExecutorMayManageDependencies(t *testing.T) {
	e := &Env{QueueRole: "executor", Root: "/w"}
	allowed := []string{
		"npm install -D @playwright/test",
		"npm install -D @playwright/test > /tmp/install.log 2>&1",
		"npm install -D @playwright/test@1.55.0",
		"npm ci",
		"pnpm add -D @playwright/test",
		"yarn add --dev @playwright/test",
		"npx playwright install chromium",
		"npx playwright test --reporter=json > report.json",
		"node node_modules/@playwright/test/cli.js test > out.log",
		"cat tests/e2e/00-stack-baseline.spec.js",
		"ls tests/e2e",
		"grep -rn 'itco' tests/",
	}
	for _, command := range allowed {
		if err := e.CheckQueueCommand(command); err != nil {
			t.Errorf("CheckQueueCommand(%q) = %v, want nil", command, err)
		}
	}
}

// The guard still has to do its actual job.
func TestExecutorMayNotRewriteTests(t *testing.T) {
	e := &Env{QueueRole: "executor", Root: "/w"}
	blocked := []string{
		"echo broken > tests/e2e/00-stack-baseline.spec.js",
		"sed -i 's/expect/skip/' tests/e2e/baseline.spec.js",
		"rm tests/e2e/00-stack-baseline.spec.js",
		"mv tests/e2e/a.spec.js tests/e2e/b.spec.js",
		"cp /tmp/fake.spec.js tests/e2e/real.spec.js",
		"node -e \"require('fs').writeFileSync('playwright.config.js','')\" playwright.config.js",
	}
	for _, command := range blocked {
		if err := e.CheckQueueCommand(command); err == nil {
			t.Errorf("CheckQueueCommand(%q) = nil, want a queue-ownership error", command)
		}
	}
}

func TestQueueStorageStaysFenced(t *testing.T) {
	e := &Env{QueueRole: "executor", Root: "/w"}
	for _, command := range []string{"sqlite3 .mfagent/queue.db 'update tasks set status=1'", "rm .mfagent/queue.db"} {
		if err := e.CheckQueueCommand(command); err == nil {
			t.Errorf("CheckQueueCommand(%q) = nil, want a queue-ownership error", command)
		}
	}
}

func TestPackageSpecifier(t *testing.T) {
	for _, c := range []struct {
		token string
		want  bool
	}{
		{"@playwright/test", true},
		{"@playwright/test@1.55.0", true},
		{"mocha", false},
		{"./tests/a.spec.js", false},
		{"/var/www/tests/a.spec.js", false},
		{"@scope/pkg/deep/path", false},
	} {
		if got := packageSpecifier(c.token); got != c.want {
			t.Errorf("packageSpecifier(%q) = %v, want %v", c.token, got, c.want)
		}
	}
}
