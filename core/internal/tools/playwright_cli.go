package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/mflores/mfagent/core/internal/playwright"
)

const cliSkillAdapter = `# MF Agent Playwright usage
Read the official skill below before interactive browser work. It is bundled by
playwright-cli install --skills. Load linked guides with playwright_skill
{"reference":"references/<name>.md"}.

Translate each documented CLI command into ONE playwright_cli tool call:
playwright-cli open https://example.com => {"args":["open","https://example.com"]}
playwright-cli click e15 => {"args":["click","e15"]}
playwright-cli run-code 'async page => ...' => {"args":["run-code","async page => ..."]}
Do not put playwright-cli, shell quotes, pipes, &&, or RPC tool names in args.
Use {"args":["--help"]} or {"args":["<command>","--help"]} for exact syntax.
The default is headless Chromium on the workspace host, including remote SSH.
If the CLI browser executable is missing, call
playwright_cli {"args":["install-browser","chromium"],"timeout_seconds":600}.
Only when missing Linux libraries are diagnosed, add --with-deps (requires OS permission).
This CLI has a separate browser version from playwright_test. For missing SUITE
browsers use playwright_install {"with_deps":false}; use true for missing Linux libraries.
Use playwright_status to inspect suite resolution. playwright_test runs real test()
specs; CLI snapshots or screenshots alone do not satisfy a required suite run.
All commands share the mfagent session in this workspace. Close it when finished.
Do not assume cookies are shared with browser_* tools or suite tests. Use fresh
snapshot refs after navigation. Snapshot paths are workspace-relative: read_file
can read them. Keep configured target URLs and credentials; never paste secret
values into CLI args. For login use browser_fill credential references, or suite
tests reading MFAGENT_CREDENTIAL_* environment variables. Owner instructions take
precedence over the example URLs and installation suggestions in upstream docs.

# Official Playwright CLI skill

`

func registerPlaywrightCLI(r *Registry) {
	r.Add(&Tool{
		Name:        "playwright_skill",
		Description: "Load Microsoft's official Playwright CLI skill and linked reference guides, with exact MF Agent tool examples. Call before using playwright_cli. No installation or opt-in needed.",
		Schema:      obj(map[string]any{"reference": str("Optional: SKILL.md (default) or references/<name>.md linked by the skill.")}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Reference string `json:"reference"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			text, err := playwright.ReadCLISkill(a.Reference)
			if err != nil {
				return Errf("%v", err)
			}
			return Ok(cliSkillAdapter + text)
		},
	})
	r.Add(&Tool{
		Name:        "playwright_cli",
		Description: "Run the bundled official playwright-cli without a shell. Read playwright_skill first. args contains individual arguments, e.g. [\"open\",\"https://example.com\"], [\"snapshot\"], [\"click\",\"e15\"], [\"close\"]. Headless Chromium, persistent mfagent session per workspace. Missing CLI browser: [\"install-browser\",\"chromium\"]. For test suites use playwright_test and playwright_install instead.",
		Mutating:    true,
		Schema: obj(map[string]any{
			"args":            map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "CLI argument array without executable or shell quoting. Use --help for syntax."},
			"timeout_seconds": num("Execution deadline, default 120, maximum 900. Use 600 for browser downloads."),
		}, "args"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Args    []string `json:"args"`
				Timeout int      `json:"timeout_seconds"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if len(a.Args) == 0 {
				return Errf("args must include a command; start with [\"--help\"]")
			}
			if a.Timeout < 0 || a.Timeout > 900 {
				return Errf("timeout_seconds must be between 0 and 900")
			}
			navigation := a.Args[0] == "open" || a.Args[0] == "goto" || a.Args[0] == "tab-new"
			if navigation && len(a.Args) > 1 && !strings.HasPrefix(a.Args[1], "-") {
				if err := env.CheckTestingURL(a.Args[1], a.Args[0] == "open"); err != nil {
					return Errf("%v", err)
				}
			}
			for _, arg := range a.Args {
				if err := env.CheckTestingCommand(arg); err != nil {
					return Errf("%v", err)
				}
				if strings.HasPrefix(arg, "http://") || strings.HasPrefix(arg, "https://") {
					if err := env.CheckTestingURL(arg, a.Args[0] == "open"); err != nil {
						return Errf("%v", err)
					}
				}
			}
			out, code, err := playwright.RunCLI(ctx, env.Root, a.Args, time.Duration(a.Timeout)*time.Second)
			if err != nil {
				out += fmt.Sprintf("\nPlaywright CLI failed: %v", err)
			}
			if strings.Contains(out, "Executable doesn't exist") || strings.Contains(out, "playwright install") {
				out += "\nMissing CLI browser: call playwright_cli with {\"args\":[\"install-browser\",\"chromium\"],\"timeout_seconds\":600}, then retry. playwright_install installs suite browsers, which may have a different revision."
			}
			if err == nil && navigation && len(a.Args) > 1 && !strings.HasPrefix(a.Args[1], "-") {
				env.MarkTestingOpened()
			}
			return Result{Output: env.RedactTestingSecrets(fmt.Sprintf("exit=%d\n%s", code, out)), IsError: err != nil || code != 0,
				Meta: map[string]any{"exitCode": code}}
		},
	})
}
