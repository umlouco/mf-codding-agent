package playwright

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// ProbeChromium uses the selected suite's module and environment, not whichever
// Chromium happens to be newest in the cache. It never visits an application.
func ProbeChromium(ctx context.Context, s *Setup) (string, error) {
	if err := s.Ready(); err != nil {
		return "", err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	const script = `
const { chromium } = require(process.argv[1]);
(async () => {
  const browser = await chromium.launch({ headless: true, timeout: 20000 });
  try { console.log('Headless Chromium launch passed: ' + browser.version()); }
  finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });`
	cmd := exec.CommandContext(probeCtx, s.NodePath, "-e", script, s.PkgDir())
	configureCommand(cmd)
	cmd.Dir = s.Root
	cmd.Env = append(s.env(), "NO_COLOR=1", "CI=1", "PWDEBUG=0")
	out, err := cmd.CombinedOutput()
	if probeCtx.Err() != nil {
		err = probeCtx.Err()
	}
	return tail(string(out), 6000), err
}

// BrowserFailure distinguishes setup problems from application assertions.
// In particular Firefox/WebKit and custom channels must not trigger a Chromium install.
func BrowserFailure(output string) string {
	lower := strings.ToLower(output)
	switch {
	case strings.Contains(lower, "executable doesn't exist") && strings.Contains(lower, "chromium"):
		return "missing_chromium"
	case strings.Contains(lower, "error while loading shared libraries"),
		strings.Contains(lower, "host system is missing dependencies"),
		strings.Contains(lower, "missing libraries:"):
		return "missing_libraries"
	case strings.Contains(lower, "missing x server"), strings.Contains(lower, "without having a xserver"),
		strings.Contains(lower, "cannot open display"):
		return "missing_display"
	case strings.Contains(lower, "running as root without --no-sandbox"),
		strings.Contains(lower, "no usable sandbox"):
		return "sandbox"
	}
	return ""
}

func reportBrowserFailure(rep *Report) string {
	// Never replay application checks that have already passed or failed for
	// another reason: the suite may have side effects.
	if rep == nil || rep.Passed+rep.Flaky > 0 {
		return ""
	}
	messages := append([]string{}, rep.TopLevelErrors...)
	for _, failure := range rep.Failures {
		if failure.Message != "" {
			messages = append(messages, failure.Message)
		}
	}
	if len(messages) == 0 && rep.RawTail != "" {
		messages = append(messages, rep.RawTail)
	}
	if len(messages) == 0 {
		return ""
	}
	for _, message := range messages {
		if BrowserFailure(message) != "missing_chromium" {
			return ""
		}
	}
	return "missing_chromium"
}

// RunWithBrowserRepair owns a single, bounded recovery. A second failed launch
// is returned to the caller, never another install/retry loop.
func RunWithBrowserRepair(ctx context.Context, s *Setup, opt RunOptions, progress func(string)) (*Report, string, error) {
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	rep, err := Run(ctx, s, opt)
	if err != nil || reportBrowserFailure(rep) != "missing_chromium" || ctx.Err() != nil {
		return rep, "", err
	}
	if progress != nil {
		progress("Missing suite Chromium; installing the matching revision on the workspace host, then retrying once.")
	}
	out, installErr := InstallBrowsers(ctx, s, false)
	receipt := fmt.Sprintf("Browser setup repair for %s (@playwright/test %s):\n%s\n", s.Root, s.Version, out)
	if installErr != nil {
		return rep, receipt, fmt.Errorf("Chromium repair failed; no retry performed: %w", installErr)
	}
	rep, err = Run(ctx, s, opt)
	return rep, receipt + "Retried the same suite once after installing Chromium.\n", err
}

// Avoid an invisible sudo password prompt on SSH hosts. Install OS libraries
// separately under sudo, then download browser binaries as the original user.
func dependencyCommand(ctx context.Context, s *Setup) (*exec.Cmd, error) {
	args := []string{s.CLIPath, "install-deps", "chromium"}
	if runtime.GOOS != "linux" || os.Geteuid() == 0 {
		return exec.CommandContext(ctx, s.NodePath, args...), nil
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		return nil, fmt.Errorf("Linux browser libraries require root or passwordless sudo on the workspace host; sudo is unavailable")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	check := exec.CommandContext(checkCtx, sudo, "-n", "true")
	configureCommand(check)
	if err := check.Run(); err != nil {
		return nil, fmt.Errorf("Linux browser libraries require root or passwordless sudo on the workspace host; sudo -n failed (no interactive password prompt attempted)")
	}
	return exec.CommandContext(ctx, sudo, append([]string{"-n", s.NodePath}, args...)...), nil
}
