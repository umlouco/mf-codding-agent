// Package playwright runs a project's own Playwright suite and turns the
// result into something an agent can act on: which specs failed, why, where,
// and which artefacts were left behind.
//
// This deliberately does not drive a browser — the browser package already
// does that over CDP with no Node dependency. This is for the other half of
// the job, where the project has real specs and the agent needs to run them
// and read the failures.
package playwright

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// configNames are the filenames Playwright itself recognises.
var configNames = []string{
	"playwright.config.ts",
	"playwright.config.js",
	"playwright.config.mjs",
	"playwright.config.cjs",
	"playwright.config.mts",
	"playwright.config.cts",
}

// Setup describes what is and is not present, so a failure can say which
// piece is missing instead of dumping a raw npx error.
type Setup struct {
	Root       string
	ConfigPath string // absolute path, "" when not found
	NodePath   string
	NpxPath    string
	CLIPath    string // installed JS entry point, invoked with node (never npx.cmd)
	Installed  bool   // @playwright/test resolvable from Root
	Version    string // best-effort, "" when unknown
}

func (s *Setup) Ready() error {
	if s.NodePath == "" {
		return errors.New("node is not on PATH — Playwright needs Node.js installed on this machine")
	}
	if !s.Installed {
		return errors.New("@playwright/test is not installed in this project — run `npm install -D @playwright/test`")
	}
	if s.CLIPath == "" {
		return errors.New("installed Playwright CLI is missing; restore the project's dependencies")
	}
	if s.ConfigPath == "" {
		return errors.New("no playwright.config.* found — Playwright needs a config to know where the specs live")
	}
	return nil
}

// Detect inspects the workspace without running anything.
func Detect(root string) *Setup {
	s := &Setup{Root: root}
	s.NodePath, _ = exec.LookPath("node")
	s.NpxPath, _ = exec.LookPath("npx")

	for _, n := range configNames {
		p := filepath.Join(root, n)
		if _, err := os.Stat(p); err == nil {
			s.ConfigPath = p
			break
		}
	}

	// Resolving the package directory is a more honest check than reading
	// package.json, which lists intent rather than what is on disk.
	pkgDir := filepath.Join(root, "node_modules", "@playwright", "test")
	if fi, err := os.Stat(pkgDir); err == nil && fi.IsDir() {
		s.Installed = true
		if info, err := os.Stat(filepath.Join(pkgDir, "cli.js")); err == nil && !info.IsDir() {
			s.CLIPath = filepath.Join(pkgDir, "cli.js")
		}
		if b, err := os.ReadFile(filepath.Join(pkgDir, "package.json")); err == nil {
			var pj struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(b, &pj) == nil {
				s.Version = pj.Version
			}
		}
	}
	return s
}

// RunOptions selects which part of the suite to run.
type RunOptions struct {
	Spec            string // file or file:line, optional
	Grep            string // title filter, optional
	Project         string // Playwright project name, optional
	Workers         int    // 0 = leave to the config
	Headed          bool
	Timeout         time.Duration
	UpdateSnapshots bool
}

// Failure is one failing spec, reduced to what is worth putting in a model's
// context: no stack noise, no ANSI, just the assertion and where it happened.
type Failure struct {
	Title       string   `json:"title"`
	File        string   `json:"file"`
	Line        int      `json:"line"`
	Project     string   `json:"project,omitempty"`
	Message     string   `json:"message"`
	Attachments []string `json:"attachments,omitempty"`
}

type Report struct {
	Passed   int
	Failed   int
	Flaky    int
	Skipped  int
	Duration time.Duration
	Failures []Failure
	// TopLevelErrors covers the cases that never reach a spec at all: a
	// config that throws, a TypeScript error, a missing browser binary.
	TopLevelErrors []string
	ExitCode       int
	RawTail        string // stderr tail, used when the JSON report is unusable
}

func (r *Report) OK() bool {
	return r.Failed == 0 && len(r.TopLevelErrors) == 0 && r.ExitCode == 0
}

// jsonReport mirrors the subset of Playwright's JSON reporter we rely on.
type jsonReport struct {
	Suites []jsonSuite `json:"suites"`
	Errors []struct {
		Message string `json:"message"`
		Stack   string `json:"stack"`
	} `json:"errors"`
	Stats struct {
		Expected   int     `json:"expected"`
		Unexpected int     `json:"unexpected"`
		Flaky      int     `json:"flaky"`
		Skipped    int     `json:"skipped"`
		Duration   float64 `json:"duration"`
	} `json:"stats"`
}

type jsonSuite struct {
	Title  string      `json:"title"`
	File   string      `json:"file"`
	Suites []jsonSuite `json:"suites"`
	Specs  []jsonSpec  `json:"specs"`
}

type jsonSpec struct {
	Title string `json:"title"`
	OK    bool   `json:"ok"`
	File  string `json:"file"`
	Line  int    `json:"line"`
	Tests []struct {
		ProjectName string `json:"projectName"`
		Status      string `json:"status"`
		Results     []struct {
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
				Stack   string `json:"stack"`
			} `json:"error"`
			Attachments []struct {
				Name string `json:"name"`
				Path string `json:"path"`
			} `json:"attachments"`
		} `json:"results"`
	} `json:"tests"`
}

// Run executes the suite and returns a parsed report. A non-zero exit status
// is an expected outcome (tests failed), not a Go error; err is reserved for
// not being able to run Playwright at all.
func Run(ctx context.Context, s *Setup, opt RunOptions) (*Report, error) {
	if err := s.Ready(); err != nil {
		return nil, err
	}

	// The JSON reporter shares stdout with anything the tests print, so send
	// it to a file instead of trying to find it in the noise.
	tmp, err := os.MkdirTemp("", "mfagent-pw-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	reportPath := filepath.Join(tmp, "report.json")

	args := []string{s.CLIPath, "test", "--reporter=json", "--config", s.ConfigPath}
	if opt.Spec != "" {
		args = append(args, opt.Spec)
	}
	if opt.Grep != "" {
		args = append(args, "--grep", opt.Grep)
	}
	if opt.Project != "" {
		args = append(args, "--project", opt.Project)
	}
	if opt.Workers > 0 {
		args = append(args, fmt.Sprintf("--workers=%d", opt.Workers))
	}
	if opt.Headed {
		args = append(args, "--headed")
	}
	if opt.UpdateSnapshots {
		args = append(args, "--update-snapshots")
	}

	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, s.NodePath, args...)
	configureCommand(cmd)
	cmd.Dir = s.Root
	cmd.Env = append(os.Environ(),
		"PLAYWRIGHT_JSON_OUTPUT_NAME="+reportPath,
		// Colour codes would end up in the model's context as escape noise.
		"FORCE_COLOR=0",
		"NO_COLOR=1",
		"CI=1",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if runCtx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("playwright test timed out after %s", timeout)
	}

	rep := &Report{}
	if ee := (*exec.ExitError)(nil); errors.As(runErr, &ee) {
		rep.ExitCode = ee.ExitCode()
	} else if runErr != nil {
		return nil, fmt.Errorf("could not run playwright: %w", runErr)
	}

	raw, readErr := os.ReadFile(reportPath)
	if readErr != nil {
		// Older versions ignore the env var and write to stdout instead.
		if b := stdout.Bytes(); json.Valid(bytes.TrimSpace(b)) {
			raw, readErr = bytes.TrimSpace(b), nil
		}
	}
	if readErr != nil || len(raw) == 0 {
		rep.RawTail = tail(stderr.String(), 4000)
		if rep.RawTail == "" {
			rep.RawTail = tail(stdout.String(), 4000)
		}
		if rep.ExitCode == 0 {
			rep.ExitCode = 1
		}
		rep.TopLevelErrors = append(rep.TopLevelErrors,
			"Playwright produced no JSON report; raw output is below.")
		return rep, nil
	}

	if err := Parse(raw, rep); err != nil {
		rep.RawTail = tail(stderr.String(), 4000)
		rep.TopLevelErrors = append(rep.TopLevelErrors,
			"could not parse Playwright's JSON report: "+err.Error())
		return rep, nil
	}
	if rep.RawTail == "" && !rep.OK() && rep.Failed == 0 {
		rep.RawTail = tail(stderr.String(), 2000)
	}
	return rep, nil
}

// Parse turns a Playwright JSON report into a Report. Split out from Run so it
// can be tested against fixtures without Node present.
func Parse(raw []byte, rep *Report) error {
	var jr jsonReport
	if err := json.Unmarshal(raw, &jr); err != nil {
		return err
	}
	rep.Passed = jr.Stats.Expected
	rep.Failed = jr.Stats.Unexpected
	rep.Flaky = jr.Stats.Flaky
	rep.Skipped = jr.Stats.Skipped
	rep.Duration = time.Duration(jr.Stats.Duration) * time.Millisecond

	for _, e := range jr.Errors {
		msg := strings.TrimSpace(e.Message)
		if msg == "" {
			msg = strings.TrimSpace(e.Stack)
		}
		if msg != "" {
			rep.TopLevelErrors = append(rep.TopLevelErrors, clean(msg))
		}
	}
	for _, s := range jr.Suites {
		collect(s, s.File, rep)
	}
	return nil
}

func collect(s jsonSuite, file string, rep *Report) {
	if s.File != "" {
		file = s.File
	}
	for _, spec := range s.Specs {
		if spec.OK {
			continue
		}
		f := spec.File
		if f == "" {
			f = file
		}
		fail := Failure{Title: spec.Title, File: f, Line: spec.Line}
		for _, t := range spec.Tests {
			// A spec that failed then passed on retry is flaky, not failing;
			// Playwright's stats already count it that way, so skip it here
			// to keep the two consistent.
			if t.Status == "flaky" || t.Status == "expected" {
				continue
			}
			fail.Project = t.ProjectName
			for _, r := range t.Results {
				if r.Error != nil && fail.Message == "" {
					fail.Message = clean(firstLines(r.Error.Message, 12))
				}
				for _, a := range r.Attachments {
					if a.Path != "" {
						fail.Attachments = append(fail.Attachments, a.Path)
					}
				}
			}
		}
		if fail.Message == "" && len(fail.Attachments) == 0 && fail.Project == "" {
			continue // counted as skipped/flaky elsewhere
		}
		rep.Failures = append(rep.Failures, fail)
	}
	for _, child := range s.Suites {
		collect(child, file, rep)
	}
}

// InstallBrowsers runs `playwright install`, which is the step people forget
// on a fresh server and which produces a famously opaque failure when missed.
func InstallBrowsers(ctx context.Context, s *Setup, withDeps bool) (string, error) {
	if s.NodePath == "" || s.CLIPath == "" {
		return "", errors.New("node and the project's installed @playwright/test CLI are required; no implicit package download is performed")
	}
	args := []string{s.CLIPath, "install", "chromium"}
	if withDeps && runtime.GOOS == "linux" {
		args = append(args, "--with-deps")
	}
	runCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(runCtx, s.NodePath, args...)
	configureCommand(cmd)
	cmd.Dir = s.Root
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "CI=1")
	out, err := cmd.CombinedOutput()
	if runCtx.Err() == context.DeadlineExceeded {
		return tail(string(out), 3000), errors.New("playwright install timed out after 15m")
	}
	if err != nil {
		return tail(string(out), 3000), fmt.Errorf("playwright install failed: %w", err)
	}
	return tail(string(out), 3000), nil
}

func firstLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[:n], "\n") + "\n…"
}

// clean strips ANSI escapes, which Playwright emits into error messages even
// with NO_COLOR set.
func clean(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == 0x1b {
			for i < len(s) && s[i] != 'm' {
				i++
			}
			continue
		}
		b.WriteByte(s[i])
	}
	return strings.TrimSpace(b.String())
}

func tail(s string, n int) string {
	s = clean(strings.TrimSpace(s))
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}
