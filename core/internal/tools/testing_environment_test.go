package tools

import (
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/config"
)

func TestLoopbackTestingTarget(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"", false},
		{"http://localhost:8123", true},
		{"http://LOCALHOST:8123/game/", true},
		{"http://127.0.0.1:5173", true},
		{"http://127.9.9.9:80", true},
		{"http://0.0.0.0:8080", true},
		{"http://[::1]:3000", true},
		{"https://example.com", false},
		{"http://staging.internal:8123", false},
		{"http://localhost.example.com", false},
		{"not a url", false},
	}
	for _, c := range cases {
		if got := LoopbackTestingTarget(c.url); got != c.want {
			t.Errorf("LoopbackTestingTarget(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

// A loopback testing target has no application behind it other than the one this
// workspace serves, so the executor must be able to start that server. Only a
// remote target names an application a development server would replace.
func TestCheckTestingCommandServerStart(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		command string
		blocked bool
	}{
		{"loopback target allows a static server", "http://localhost:8123", "python -m http.server 8123", false},
		{"loopback target allows a dev server", "http://127.0.0.1:5173", "npm run dev", false},
		{"loopback target allows php's server", "http://localhost:8000", "php -S localhost:8000", false},
		{"remote target still blocks a server", "https://example.com", "python -m http.server 8123", true},
		{"unconfigured target allows a server", "", "npm run dev", false},
		{"remote target still blocks a substitute URL", "https://example.com", "curl http://localhost:8123/", true},
		{"loopback target blocks another origin", "http://localhost:8123", "curl http://localhost:9999/", true},
		{"loopback target allows its own origin", "http://localhost:8123", "curl http://localhost:8123/", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env := &Env{Testing: config.TestingEnvironment{URL: c.url}}
			err := env.CheckTestingCommand(c.command)
			if c.blocked && err == nil {
				t.Fatalf("CheckTestingCommand(%q) with target %q allowed the command", c.command, c.url)
			}
			if !c.blocked && err != nil {
				t.Fatalf("CheckTestingCommand(%q) with target %q refused it: %v", c.command, c.url, err)
			}
		})
	}
}

// The tool the executor reads before application work must state who serves the
// configured address, or a correct refusal and a correct instruction disagree.
func TestTestingEnvironmentToolExplainsWhoServesTheTarget(t *testing.T) {
	r := NewRegistry()
	RegisterTestingEnvironment(r)
	tool, ok := r.Get("testing_environment")
	if !ok {
		t.Fatal("testing_environment is not registered")
	}
	run := func(url string) string {
		env := &Env{Testing: config.TestingEnvironment{URL: url}}
		return tool.Run(t.Context(), env, []byte(`{}`)).Output
	}
	local := run("http://localhost:8123")
	if !strings.Contains(local, "served from this workspace") {
		t.Errorf("a loopback target must say the workspace serves it: %q", local)
	}
	if strings.Contains(local, "Do not replace the supplied application") {
		t.Errorf("a loopback target must not forbid the server it needs: %q", local)
	}
	remote := run("https://example.com")
	if !strings.Contains(remote, "Do not replace the supplied application") {
		t.Errorf("a remote target must still forbid a substitute: %q", remote)
	}
	if strings.Contains(remote, "served from this workspace") {
		t.Errorf("a remote target must not claim the workspace serves it: %q", remote)
	}
}
