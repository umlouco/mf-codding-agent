package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/mflores/mfagent/core/internal/config"
)

var credentialName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`)
var literalLoopbackURL = regexp.MustCompile(`(?i)https?://(?:localhost|127(?:\.[0-9]+){3}|0\.0\.0\.0|\[::1\])(?::[0-9]+)?(?:/[^\s'"\x60<>]*)?`)
var serverCommand = regexp.MustCompile(`(?i)(?:\bpython(?:3|\.exe)?\s+-m\s+http\.server\b|\bphp(?:\.exe)?\s+-S\s|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|start)\b|\bnpx\s+(?:serve|http-server|vite)\b)`)
var browserSuiteCommand = regexp.MustCompile(`(?i)\b(?:playwright(?:\.cmd)?\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test)\b`)
var selectedSpecArgument = regexp.MustCompile(`(?i)(?:^|\s)(?:"([^"]+\.(?:spec|test)\.[cm]?[jt]s)"|'([^']+\.(?:spec|test)\.[cm]?[jt]s)'|([^\s'"]+\.(?:spec|test)\.[cm]?[jt]s))(?:\s|$)`)

// ApplyTestingProcessEnvironment affects this private core process and its children,
// never the editor's environment. Reinitialization removes obsolete credential names.
func ApplyTestingProcessEnvironment(testing config.TestingEnvironment) error {
	if testing.URL != "" {
		u, err := url.Parse(testing.URL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return fmt.Errorf("invalid owner-configured testing URL")
		}
	}
	for name := range testing.Credentials {
		if !credentialName.MatchString(name) {
			return fmt.Errorf("invalid testing credential name")
		}
	}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "MFAGENT_CREDENTIAL_") {
			_ = os.Unsetenv(name)
		}
	}
	_ = os.Setenv("MFAGENT_TEST_URL", testing.URL)
	for name, value := range testing.Credentials {
		if err := os.Setenv("MFAGENT_CREDENTIAL_"+strings.ToUpper(name), value); err != nil {
			return err
		}
	}
	return nil
}

// Standalone verification commands inherit the same environment without an RPC initialize.
func TestingFromEnvironment() config.TestingEnvironment {
	result := config.TestingEnvironment{URL: os.Getenv("MFAGENT_TEST_URL"), Credentials: map[string]string{}}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "MFAGENT_CREDENTIAL_") {
			result.Credentials[strings.ToLower(strings.TrimPrefix(name, "MFAGENT_CREDENTIAL_"))] = value
		}
	}
	return result
}

func (e *Env) RedactTestingSecrets(text string) string {
	values := make([]string, 0, len(e.Testing.Credentials))
	for name, value := range e.Testing.Credentials {
		if !testingIdentityName(name) && value != "" {
			values = append(values, value)
		}
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	for _, value := range values {
		text = strings.ReplaceAll(text, value, "[REDACTED]")
	}
	return text
}

func sameOrigin(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if u.Port() != "" {
			return u.Port()
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

func (e *Env) CheckTestingURL(target string, first bool) error {
	if e.Testing.URL == "" {
		return nil
	}
	owner, err := url.Parse(e.Testing.URL)
	if err != nil || owner.Host == "" {
		return fmt.Errorf("invalid configured testing URL")
	}
	got, err := url.Parse(target)
	if err != nil || !sameOrigin(owner, got) || got.User != nil {
		return fmt.Errorf("the owner configured testing URL %s; use that environment, not a substitute host or local server", e.Testing.URL)
	}
	e.testingMu.Lock()
	opened := e.testingOpened
	e.testingMu.Unlock()
	if first && !opened && (strings.TrimRight(got.Path, "/") != strings.TrimRight(owner.Path, "/") || got.RawQuery != owner.RawQuery) {
		return fmt.Errorf("open the owner's exact testing URL first: %s; then navigate the actual application and authenticate using configured credentials", e.Testing.URL)
	}
	return nil
}

func (e *Env) MarkTestingOpened() { e.testingMu.Lock(); e.testingOpened = true; e.testingMu.Unlock() }

func (e *Env) CheckTestingCommand(command string) error {
	if e.Testing.URL == "" {
		return nil
	}
	if serverCommand.MatchString(command) {
		return fmt.Errorf("a testing application is already configured at %s; starting a replacement development server is disabled", e.Testing.URL)
	}
	for _, target := range literalLoopbackURL.FindAllString(command, -1) {
		if err := e.CheckTestingURL(target, false); err != nil {
			return err
		}
	}
	// A runner command often contains no URL: the bad address is in its spec
	// or configuration. Inspect those inputs before launching a browser suite.
	if browserSuiteCommand.MatchString(command) && e.Root != "" {
		selected := map[string]bool{}
		for _, match := range selectedSpecArgument.FindAllStringSubmatch(command, -1) {
			for _, arg := range match[1:] {
				if arg != "" {
					selected[strings.ToLower(arg[strings.LastIndexAny(arg, `/\`)+1:])] = true
				}
			}
		}
		return filepath.WalkDir(e.Root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				switch d.Name() {
				case "node_modules", ".git", ".mfagent", "vendor", "test-results", "playwright-report":
					return filepath.SkipDir
				}
				return nil
			}
			name := strings.ToLower(d.Name())
			if len(selected) > 0 && !selected[name] && !strings.HasPrefix(name, "playwright.config.") {
				return nil
			}
			if !(strings.Contains(name, ".spec.") || strings.Contains(name, ".test.") || strings.HasPrefix(name, "playwright.config.")) {
				return nil
			}
			switch filepath.Ext(name) {
			case ".js", ".ts", ".mjs", ".cjs", ".mts", ".cts":
			default:
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if !strings.HasPrefix(name, "playwright.config.") && !strings.Contains(string(data), "playwright") {
				return nil
			}
			for _, target := range literalLoopbackURL.FindAllString(string(data), -1) {
				if err := e.CheckTestingURL(target, false); err != nil {
					return fmt.Errorf("testing target blocked: %s contains a substitute localhost URL. Use MFAGENT_TEST_URL (%s) and remove stale local test targets before running the suite", path, e.Testing.URL)
				}
			}
			return nil
		})
	}
	return nil
}

// Applies to native and forwarded browser calls. Shell-specific enforcement also
// lives in the shell tools so direct sh/verification entry points use the policy.
func (e *Env) CheckTestingTool(name string, input json.RawMessage) error {
	if e.Testing.URL == "" {
		return nil
	}
	var args map[string]any
	if json.Unmarshal(input, &args) != nil {
		return nil
	}
	if testingBrowserTool(name) {
		for _, key := range []string{"url", "start_url", "baseURL", "base_url"} {
			if target, ok := args[key].(string); ok && target != "" {
				if err := e.CheckTestingURL(target, true); err != nil {
					return err
				}
			}
		}
	}
	if command, ok := args["command"].(string); ok {
		return e.CheckTestingCommand(command)
	}
	return nil
}

func RegisterTestingEnvironment(r *Registry) {
	r.Add(&Tool{Name: "testing_environment", Description: "Read the owner's fixed testing URL and available named credentials. Values stay secret: use browser_fill's credential field or MFAGENT_CREDENTIAL_<NAME> environment variables in terminal commands/tests. Credentials work without a testing URL. A configured URL forbids replacement localhost servers.", Schema: obj(map[string]any{}),
		Run: func(ctx context.Context, env *Env, input json.RawMessage) Result {
			names := make([]string, 0, len(env.Testing.Credentials))
			for name := range env.Testing.Credentials {
				names = append(names, name)
			}
			sort.Strings(names)
			var out strings.Builder
			fmt.Fprintf(&out, "Testing URL: %s\nTerminal/test URL variable: MFAGENT_TEST_URL\n", orNone(env.Testing.URL))
			for _, name := range names {
				fmt.Fprintf(&out, "Credential %s: browser_fill credential=%q; terminal environment variable MFAGENT_CREDENTIAL_%s\n", name, name, strings.ToUpper(name))
			}
			if len(names) == 0 {
				out.WriteString("No credentials configured. Do not invent an account.\n")
			}
			out.WriteString("Use process.env in Node tests, $env:NAME in PowerShell, or $NAME in the portable unix shell. Never print or persist their values. Do not replace the supplied application with a fixture or another server.")
			return Ok(out.String())
		}})
}

// Redact parsed values rather than JSON bytes so quotes and backslashes in secrets remain safe.
func (e *Env) RedactTestingInput(input json.RawMessage) json.RawMessage {
	var value any
	if json.Unmarshal(input, &value) != nil {
		return json.RawMessage(`{}`)
	}
	var redact func(any) any
	redact = func(v any) any {
		switch x := v.(type) {
		case string:
			return e.RedactTestingSecrets(x)
		case []any:
			for i := range x {
				x[i] = redact(x[i])
			}
		case map[string]any:
			for k := range x {
				x[k] = redact(x[k])
			}
		}
		return v
	}
	result, err := json.Marshal(redact(value))
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return result
}

func (e *Env) ObserveTestingTool(name string, input json.RawMessage) {
	if !testingBrowserTool(name) {
		return
	}
	var args map[string]any
	if json.Unmarshal(input, &args) != nil {
		return
	}
	for _, key := range []string{"url", "start_url", "baseURL", "base_url"} {
		if target, ok := args[key].(string); ok && target != "" && e.CheckTestingURL(target, true) == nil {
			e.MarkTestingOpened()
		}
	}
}

func (e *Env) TestingPrompt(text string) string {
	names := make([]string, 0, len(e.Testing.Credentials))
	for name := range e.Testing.Credentials {
		if !testingIdentityName(name) {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return len(e.Testing.Credentials[names[i]]) > len(e.Testing.Credentials[names[j]])
	})
	for _, name := range names {
		if value := e.Testing.Credentials[name]; value != "" {
			text = strings.ReplaceAll(text, value, "(configured credential "+name+"; use MFAGENT_CREDENTIAL_"+strings.ToUpper(name)+")")
		}
	}
	return text
}

func testingBrowserTool(name string) bool {
	return strings.Contains(name, "browser") || strings.Contains(name, "playwright") || strings.HasSuffix(name, "navigate_page") || strings.HasSuffix(name, "open_page")
}

// Usernames are identifiers and commonly overlap source paths such as wp-admin.
// Their values are still omitted from configuration tools; redact passwords/tokens from results.
func testingIdentityName(name string) bool {
	return strings.EqualFold(name, "username") || strings.EqualFold(name, "user")
}
