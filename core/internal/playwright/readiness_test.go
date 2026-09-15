package playwright

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestBrowserFailureDiagnosis(t *testing.T) {
	for input, want := range map[string]string{
		"browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell": "missing_chromium",
		"Executable doesn't exist at /cache/firefox-123/firefox":                                                                              "",
		"Expected text playwright install but received error":                                                                                 "",
		"error while loading shared libraries: libatk-1.0.so.0":                                                                               "missing_libraries",
		"Host system is missing dependencies to run browsers.":                                                                                "missing_libraries",
		"Missing X server or $DISPLAY":                                                                                                        "missing_display",
		"Running as root without --no-sandbox is not supported":                                                                               "sandbox",
		"expect(received).toBe(expected)":                                                                                                     "",
	} {
		if got := BrowserFailure(input); got != want {
			t.Errorf("%q: got %q want %q", input, got, want)
		}
	}
}

func TestSuiteRepairUsesPinnedCLIAndRetriesOnlyOnce(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}
	for _, scenario := range []string{"fixed", "still-missing", "download-fails", "assertion", "partial-pass"} {
		t.Run(scenario, func(t *testing.T) {
			t.Setenv("MFAGENT_PLAYWRIGHT_ROOT", "")
			t.Setenv("MFAGENT_PLAYWRIGHT_HOME", fakeRuntime(t, "other-version"))
			suite := fakeRuntime(t, "suite-pinned")
			t.Setenv("MF_REPAIR_SCENARIO", scenario)
			write(t, filepath.Join(suite, "node_modules", "@playwright", "test", "cli.js"), `
const fs = require('fs');
const path = require('path');
const calls = path.join(process.cwd(), 'calls.txt');
const command = process.argv[2];
const previous = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
fs.appendFileSync(calls, command + '\n');
const scenario = process.env.MF_REPAIR_SCENARIO;
if (command === 'install') { process.exit(scenario === 'download-fails' ? 9 : 0); }
const ok = scenario === 'fixed' && previous.includes('install');
const message = scenario === 'assertion' ? 'Expected title Home but received Error' :
  "Executable doesn't exist at /cache/chromium_headless_shell-1187/headless_shell";
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({
 stats: { expected: ok || scenario === 'partial-pass' ? 1 : 0, unexpected: ok ? 0 : 1 },
 errors: ok ? [] : [{message}]
}));
process.exitCode = ok ? 0 : 1;`)
			rep, receipt, err := RunWithBrowserRepair(context.Background(), Detect(suite), RunOptions{Timeout: 20 * time.Second}, nil)
			calls, readErr := os.ReadFile(filepath.Join(suite, "calls.txt"))
			if readErr != nil {
				t.Fatal(readErr)
			}
			want := "test\ninstall\ntest\n"
			if scenario == "download-fails" {
				want = "test\ninstall\n"
			}
			if scenario == "assertion" || scenario == "partial-pass" {
				want = "test\n"
			}
			if string(calls) != want {
				t.Fatalf("unexpected recovery loop: %q, want %q", calls, want)
			}
			if (err != nil) != (scenario == "download-fails") {
				t.Fatalf("wrong error: %v", err)
			}
			if rep == nil || rep.OK() != (scenario == "fixed") {
				t.Fatalf("false success: %+v", rep)
			}
			if strings.Contains(want, "install") && !strings.Contains(receipt, "suite-pinned") {
				t.Fatal("repair lost runtime identity")
			}
		})
	}
}

func TestProbeUsesSuiteModuleAndDoesNotVisitApplication(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}
	t.Setenv("MFAGENT_PLAYWRIGHT_ROOT", "")
	suite := fakeRuntime(t, "suite-pinned")
	write(t, filepath.Join(suite, "node_modules", "@playwright", "test", "index.js"), `
exports.chromium = { launch: async options => {
 if (!options.headless) throw new Error('must be headless');
 return {version: () => 'pinned-browser', close: async () => {}};
}};`)
	out, err := ProbeChromium(context.Background(), Detect(suite))
	if err != nil || !strings.Contains(out, "pinned-browser") {
		t.Fatalf("probe failed: %s %v", out, err)
	}
}

func TestHeadlessShellCacheIsDiscovered(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("PLAYWRIGHT_BROWSERS_PATH", cache)
	rel := filepath.Join("chrome-linux", "headless_shell")
	if runtime.GOOS == "windows" {
		rel = filepath.Join("chrome-win", "headless_shell.exe")
	}
	if runtime.GOOS == "darwin" {
		rel = filepath.Join("chrome-mac", "headless_shell")
	}
	exe := filepath.Join(cache, "chromium_headless_shell-1187", rel)
	if err := os.MkdirAll(filepath.Dir(exe), 0755); err != nil {
		t.Fatal(err)
	}
	write(t, exe, "fixture")
	for _, candidate := range ChromiumPaths() {
		if candidate == exe {
			return
		}
	}
	t.Fatalf("headless shell was ignored: %s", exe)
}
