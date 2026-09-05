package playwright

import (
	"context"
	"encoding/json"
	"github.com/mflores/mfagent/core/internal/layout"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Playwright colours its error messages and the escapes survive into the JSON
// report even with NO_COLOR set, where they appear as  — a raw ESC byte
// is not legal inside a JSON string. The fixture uses a token that is expanded
// to exactly the escape a real report carries, and the JSON decoder turns it
// back into a control character for clean() to strip.
const escToken = "<ESC>"

func fixture(s string) []byte {
	jsonEscapedESC := `\` + "u001b"
	return []byte(strings.ReplaceAll(s, escToken, jsonEscapedESC))
}

func TestRunUsesInstalledNodeCLIWithLiteralArguments(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node unavailable")
	}
	root := filepath.Join(t.TempDir(), "project with spaces")
	if err = os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(root, "cli.cjs")
	script := `const fs=require('fs');fs.writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME,JSON.stringify({suites:[],errors:[],stats:{expected:1,unexpected:0}}));`
	if err = os.WriteFile(cli, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	setup := &Setup{Root: root, NodePath: node, CLIPath: cli, Installed: true, ConfigPath: filepath.Join(root, "playwright.config.js")}
	spec := `layout spec; echo SHOULD_NOT_RUN`
	report, err := Run(context.Background(), setup, RunOptions{Spec: spec})
	if err != nil || !report.OK() {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "args.json"))
	if err != nil {
		t.Fatal(err)
	}
	var args []string
	if err = json.Unmarshal(raw, &args); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, arg := range args {
		if arg == spec {
			found = true
		}
	}
	if !found {
		t.Fatalf("spec argument changed: %v", args)
	}
}

func TestLayoutCaptureWithInstalledPlaywright(t *testing.T) {
	root := os.Getenv("MFAGENT_TEST_PLAYWRIGHT_ROOT")
	chrome := os.Getenv("MFAGENT_TEST_CHROME")
	if root == "" || chrome == "" {
		t.Skip("set MFAGENT_TEST_PLAYWRIGHT_ROOT and MFAGENT_TEST_CHROME for live replay")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<button id="show" onclick="document.querySelector('#panel').hidden=false">Show</button><div id="panel" hidden>Ready</div>`))
	}))
	defer server.Close()
	capture, err := CaptureLayout(context.Background(), Detect(root), layout.Spec{Width: 800, Height: 600, Criteria: []layout.Criterion{{ID: "panel", Requirement: "Panel is visible below button", Selectors: []string{"#panel"}}}}, server.URL, chrome, "", []LayoutStep{{Kind: "click", Selector: "#show"}, {Kind: "visible", Selector: "#panel"}})
	if err != nil {
		t.Fatal(err)
	}
	if !capture.Stable || len(capture.PNG) == 0 || !strings.Contains(string(capture.DOM), `"visible":true`) {
		t.Fatalf("bad capture: %+v", capture)
	}
	if !strings.Contains(string(capture.Behavior), `"completed":true`) {
		t.Fatal("missing replay evidence")
	}
}

// A report with one passing and one failing spec, nested one suite deep, which
// is the shape Playwright actually emits (file suite -> describe suite).
const mixedReport = `{
  "suites": [
    {
      "title": "login.spec.ts",
      "file": "e2e/login.spec.ts",
      "specs": [],
      "suites": [
        {
          "title": "login",
          "file": "e2e/login.spec.ts",
          "specs": [
            {
              "title": "accepts valid credentials",
              "ok": true,
              "file": "e2e/login.spec.ts",
              "line": 7,
              "tests": [{"projectName":"chromium","status":"expected",
                         "results":[{"status":"passed"}]}]
            },
            {
              "title": "rejects a bad password",
              "ok": false,
              "file": "e2e/login.spec.ts",
              "line": 19,
              "tests": [{"projectName":"chromium","status":"unexpected",
                "results":[{
                  "status":"failed",
                  "error":{"message":"<ESC>[31mExpected<ESC>[39m 401, got 500"},
                  "attachments":[
                    {"name":"screenshot","path":"/w/test-results/login-1/shot.png"},
                    {"name":"trace","path":"/w/test-results/login-1/trace.zip"},
                    {"name":"stdout","path":""}
                  ]}]}]
            }
          ],
          "suites": []
        }
      ]
    }
  ],
  "errors": [],
  "stats": {"expected":1,"unexpected":1,"flaky":0,"skipped":0,"duration":4210.5}
}`

func TestParseMixedReport(t *testing.T) {
	var rep Report
	if err := Parse(fixture(mixedReport), &rep); err != nil {
		t.Fatalf("Parse: %v", err)
	}

	if rep.Passed != 1 || rep.Failed != 1 {
		t.Fatalf("passed=%d failed=%d, want 1/1", rep.Passed, rep.Failed)
	}
	if rep.Duration.Milliseconds() != 4210 {
		t.Errorf("duration = %v, want 4210ms", rep.Duration)
	}
	if rep.OK() {
		t.Error("OK() true despite a failure")
	}
	if len(rep.Failures) != 1 {
		t.Fatalf("got %d failures, want 1", len(rep.Failures))
	}

	f := rep.Failures[0]
	if f.Title != "rejects a bad password" {
		t.Errorf("title = %q", f.Title)
	}
	if f.File != "e2e/login.spec.ts" || f.Line != 19 {
		t.Errorf("location = %s:%d, want e2e/login.spec.ts:19", f.File, f.Line)
	}
	if f.Project != "chromium" {
		t.Errorf("project = %q", f.Project)
	}
	// ANSI escapes must not reach the model's context.
	if strings.ContainsRune(f.Message, 0x1b) {
		t.Errorf("message still contains ANSI escapes: %q", f.Message)
	}
	if f.Message != "Expected 401, got 500" {
		t.Errorf("message = %q, want %q", f.Message, "Expected 401, got 500")
	}
	// The empty-path attachment must be dropped, not surfaced as "".
	if len(f.Attachments) != 2 {
		t.Errorf("attachments = %v, want the 2 with real paths", f.Attachments)
	}
}

// A config that throws never produces specs — only a top-level error. This is
// the case that used to look like "0 passed, 0 failed" and read as success.
func TestParseTopLevelError(t *testing.T) {
	const raw = `{
      "suites": [],
      "errors": [{"message":"Error: Cannot find module './missing'"}],
      "stats": {"expected":0,"unexpected":0,"flaky":0,"skipped":0,"duration":12}
    }`
	var rep Report
	if err := Parse([]byte(raw), &rep); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if rep.OK() {
		t.Fatal("OK() true for a report whose config failed to load")
	}
	if len(rep.TopLevelErrors) != 1 ||
		!strings.Contains(rep.TopLevelErrors[0], "Cannot find module") {
		t.Fatalf("TopLevelErrors = %v", rep.TopLevelErrors)
	}
}

// A spec that fails then passes on retry is flaky. It must not also be listed
// as a failure, or the summary contradicts the detail.
func TestFlakyNotCountedAsFailure(t *testing.T) {
	const raw = `{
      "suites": [{
        "title":"a.spec.ts","file":"a.spec.ts","suites":[],
        "specs":[{
          "title":"retries","ok":true,"file":"a.spec.ts","line":3,
          "tests":[{"projectName":"chromium","status":"flaky","results":[
            {"status":"failed","error":{"message":"timeout"}},
            {"status":"passed"}]}]}]}],
      "errors": [],
      "stats": {"expected":0,"unexpected":0,"flaky":1,"skipped":0,"duration":900}
    }`
	var rep Report
	if err := Parse([]byte(raw), &rep); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if rep.Flaky != 1 {
		t.Errorf("Flaky = %d, want 1", rep.Flaky)
	}
	if len(rep.Failures) != 0 {
		t.Errorf("flaky spec reported as a failure: %+v", rep.Failures)
	}
	if !rep.OK() {
		t.Error("OK() false when the only issue was a flake that passed on retry")
	}
}

func TestParseAllPassing(t *testing.T) {
	const raw = `{"suites":[],"errors":[],
      "stats":{"expected":12,"unexpected":0,"flaky":0,"skipped":2,"duration":800}}`
	var rep Report
	if err := Parse([]byte(raw), &rep); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !rep.OK() {
		t.Fatal("OK() false for a clean run")
	}
	if rep.Passed != 12 || rep.Skipped != 2 {
		t.Errorf("passed=%d skipped=%d", rep.Passed, rep.Skipped)
	}
}

func TestDetectReportsWhatIsMissing(t *testing.T) {
	root := t.TempDir()

	s := Detect(root)
	if s.ConfigPath != "" {
		t.Error("found a config in an empty dir")
	}
	if s.Installed {
		t.Error("reported @playwright/test installed in an empty dir")
	}
	if err := s.Ready(); err == nil {
		t.Fatal("Ready() returned nil for an empty dir")
	}

	// Now make it look like a real project.
	pkg := filepath.Join(root, "node_modules", "@playwright", "test")
	if err := os.MkdirAll(pkg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkg, "package.json"),
		[]byte(`{"version":"1.48.2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "playwright.config.ts"),
		[]byte("export default {}"), 0o644); err != nil {
		t.Fatal(err)
	}

	s = Detect(root)
	if !s.Installed || s.Version != "1.48.2" {
		t.Errorf("installed=%v version=%q", s.Installed, s.Version)
	}
	if filepath.Base(s.ConfigPath) != "playwright.config.ts" {
		t.Errorf("ConfigPath = %q", s.ConfigPath)
	}
}
