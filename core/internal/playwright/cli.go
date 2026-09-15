package playwright

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// CLIHome is separate from the suite runtime: upstream pins different browser builds.
func CLIHome() string { return filepath.Join(bundledHome(), "cli") }

func CLIPath() string {
	if bundledHome() == "" {
		return ""
	}
	p := filepath.Join(CLIHome(), "node_modules", "@playwright", "cli", "playwright-cli.js")
	if info, err := os.Stat(p); err == nil && !info.IsDir() {
		return p
	}
	return ""
}

// ReadCLISkill exposes only the shipped upstream skill and its reference pages.
// Project file tools deliberately cannot read the extension installation tree.
func ReadCLISkill(reference string) (string, error) {
	if CLIPath() == "" {
		return "", fmt.Errorf("bundled Playwright CLI missing; rebuild/reinstall the extension with npm run build:playwright")
	}
	if reference == "" {
		reference = "SKILL.md"
	}
	reference = filepath.FromSlash(reference)
	if filepath.IsAbs(reference) || strings.Contains(reference, ":") {
		return "", fmt.Errorf("use a relative skill reference")
	}
	reference = filepath.Clean(reference)
	if reference != "SKILL.md" && (!strings.HasPrefix(reference, "references"+string(filepath.Separator)) || filepath.Ext(reference) != ".md") {
		return "", fmt.Errorf("read SKILL.md or references/<name>.md listed in that skill")
	}
	data, err := os.ReadFile(filepath.Join(CLIHome(), ".claude", "skills", "playwright-cli", reference))
	return string(data), err
}

// RunCLI preserves each argument exactly, including JavaScript, spaces and URL '&'.
func RunCLI(ctx context.Context, root string, args []string, timeout time.Duration) (string, int, error) {
	entry := CLIPath()
	if entry == "" {
		return "", -1, fmt.Errorf("bundled Playwright CLI missing; rebuild/reinstall the extension with npm run build:playwright")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", -1, fmt.Errorf("Node.js is required on the workspace host: %w", err)
	}
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// A dedicated session survives disposable queue workers without taking over
	// the owner's default CLI session. Upstream also namespaces it by workspace.
	argv := []string{entry}
	if len(args) > 0 && args[0] == "open" {
		configured := false
		if _, err := os.Stat(filepath.Join(root, ".playwright", "cli.config.json")); err == nil {
			configured = true
		}
		for _, arg := range args {
			if strings.HasPrefix(arg, "--config") || strings.HasPrefix(arg, "--browser") {
				configured = true
			}
		}
		if !configured {
			argv = append(argv, "--config="+filepath.Join(CLIHome(), "mfagent.config.json"))
		}
	}
	argv = append(argv, args...)
	cmd := exec.CommandContext(runCtx, node, argv...)
	configureCommand(cmd)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "NO_COLOR=1", "CI=1", "PLAYWRIGHT_CLI_SESSION=mfagent")
	out, err := cmd.CombinedOutput()
	code := -1
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if runCtx.Err() != nil {
		return tail(string(out), 60000), code, runCtx.Err()
	}
	return tail(string(out), 60000), code, err
}
