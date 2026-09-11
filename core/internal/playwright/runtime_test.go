package playwright

import (
	"os"
	"path/filepath"
	"testing"
)

// fakeRuntime builds a directory shaped like the bundled runtime.
func fakeRuntime(t *testing.T, version string) string {
	t.Helper()
	home := t.TempDir()
	pkg := filepath.Join(home, "node_modules", "@playwright", "test")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(pkg, "cli.js"), "// cli")
	write(t, filepath.Join(pkg, "package.json"), `{"version":"`+version+`"}`)
	return home
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The point of the whole change: a project with no test dependencies of its
// own is ready to run, because the extension brought the runtime.
func TestBundledRuntimeMakesAnEmptyProjectReady(t *testing.T) {
	t.Setenv("MFAGENT_PLAYWRIGHT_ROOT", "")
	t.Setenv("MFAGENT_PLAYWRIGHT_HOME", fakeRuntime(t, "1.55.0"))

	project := t.TempDir()
	s := Detect(project)

	if s.Origin != OriginBundled {
		t.Fatalf("Origin = %q, want %q", s.Origin, OriginBundled)
	}
	if s.Version != "1.55.0" {
		t.Errorf("Version = %q, want 1.55.0", s.Version)
	}
	if s.Root != project {
		t.Errorf("Root = %q, want the project %q — specs stay where they are", s.Root, project)
	}
	if s.NodePath == "" {
		t.Skip("node is not on PATH in this environment")
	}
	if err := s.Ready(); err != nil {
		t.Fatalf("Ready() = %v, want nil", err)
	}
}

// A project that owns its dependencies keeps running against them.
func TestProjectRuntimeWins(t *testing.T) {
	t.Setenv("MFAGENT_PLAYWRIGHT_ROOT", "")
	t.Setenv("MFAGENT_PLAYWRIGHT_HOME", fakeRuntime(t, "1.55.0"))

	project := fakeRuntime(t, "1.40.0")
	s := Detect(project)
	if s.Origin != OriginProject {
		t.Fatalf("Origin = %q, want %q", s.Origin, OriginProject)
	}
	if s.Version != "1.40.0" {
		t.Errorf("Version = %q, want the project's 1.40.0", s.Version)
	}
}

// Nothing anywhere must not tell a worker to go and install it.
func TestNoRuntimeDoesNotAskTheAgentToInstall(t *testing.T) {
	t.Setenv("MFAGENT_PLAYWRIGHT_ROOT", "")
	t.Setenv("MFAGENT_PLAYWRIGHT_HOME", "")

	s := Detect(t.TempDir())
	if s.Origin != OriginNone || s.Installed {
		t.Fatalf("Origin = %q installed = %v, want none/false", s.Origin, s.Installed)
	}
	err := s.Ready()
	if err == nil {
		t.Fatal("Ready() = nil, want an error")
	}
	if contains(err.Error(), "npm install") {
		t.Errorf("Ready() tells the agent to run npm install, which is what it must never do: %v", err)
	}
}

// The link is what lets a project's own spec resolve @playwright/test by name.
func TestEnsureResolvableLinksTheRuntimeIn(t *testing.T) {
	home := fakeRuntime(t, "1.55.0")
	project := t.TempDir()

	if err := EnsureResolvable(project, home); err != nil {
		t.Fatalf("EnsureResolvable() = %v", err)
	}
	resolved := filepath.Join(project, "node_modules", "@playwright", "test", "cli.js")
	if _, err := os.Stat(resolved); err != nil {
		t.Fatalf("a spec in the project cannot resolve @playwright/test: %v", err)
	}
}

// A project that already has a node_modules keeps it; only the missing
// packages are linked in beside its own.
func TestEnsureResolvablePreservesExistingModules(t *testing.T) {
	home := fakeRuntime(t, "1.55.0")
	project := t.TempDir()
	own := filepath.Join(project, "node_modules", "lodash")
	if err := os.MkdirAll(own, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := EnsureResolvable(project, home); err != nil {
		t.Fatalf("EnsureResolvable() = %v", err)
	}
	if _, err := os.Stat(own); err != nil {
		t.Errorf("the project's own dependency was disturbed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(project, "node_modules", "@playwright", "test", "cli.js")); err != nil {
		t.Errorf("@playwright/test was not linked in beside it: %v", err)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && filepath.Clean(haystack) != "" &&
		(func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		})()
}
