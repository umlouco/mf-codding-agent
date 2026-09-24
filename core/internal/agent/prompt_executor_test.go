package agent

import (
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/tools"
)

func TestExecutorPromptOwnershipAndSize(t *testing.T) {
	prompt := BuildSystemPrompt(PromptInput{QueueRole: "executor", BrowserReady: true})
	t.Logf("Executor system policy: %d words", len(strings.Fields(prompt)))
	for _, unwanted := range []string{"Formal verification", "Follow the role assigned in the current task", "1..8 concrete visual criteria"} {
		if strings.Contains(prompt, unwanted) {
			t.Errorf("executor prompt contains conflicting or task-independent guidance: %s", unwanted)
		}
	}
	if len(strings.Fields(prompt)) > 850 {
		t.Errorf("executor system prompt too long: %d words", len(strings.Fields(prompt)))
	}
	for _, required := range []string{"implementation executor", "development checks", "TDD", "old_string", "line numbers", "NEEDS_MORE_WORK"} {
		if !strings.Contains(prompt, required) {
			t.Errorf("missing executor guidance: %s", required)
		}
	}
}

func TestExecutorPromptPreservesRuntimeContext(t *testing.T) {
	prompt := BuildSystemPrompt(PromptInput{QueueRole: "executor", WorkspaceRoot: "workspace-fixture",
		TestingURL: "https://example.invalid/api", HasTestingCredentials: true,
		MemoryEnabled: true, MCPServers: []string{"domain-docs"}, EditorTools: 2,
		Languages: []string{"Go"}, ProjectFacts: "Owner fact: preserve host values.", Skills: "Owner skill: use regression tests."})
	for _, required := range []string{"workspace-fixture", "https://example.invalid/api", "testing_environment",
		"MFAGENT_CREDENTIAL_", "memory_recall", "domain-docs", "editor__", "Go",
		"Owner fact: preserve host values.", "Owner skill: use regression tests."} {
		if !strings.Contains(prompt, required) {
			t.Errorf("lost configured context: %s", required)
		}
	}
	plain := BuildSystemPrompt(PromptInput{QueueRole: "executor"})
	for _, capability := range []string{"playwright_skill", "playwright_cli", "playwright_install"} {
		if !strings.Contains(plain, capability) {
			t.Errorf("fresh host cannot discover %s", capability)
		}
	}
	for _, disabled := range []string{"memory_recall", "editor__", "testing_environment", "browser_*"} {
		if strings.Contains(plain, disabled) {
			t.Errorf("disabled capability included: %s", disabled)
		}
	}
	if !strings.Contains(BuildSystemPrompt(PromptInput{}), "# Working style") {
		t.Error("interactive coder policy changed")
	}
}

func TestMCPPolicyPresentForAllRoles(t *testing.T) {
	servers := []string{"jira", "connexall-confluence"}
	roles := []PromptInput{
		{QueueRole: "", MCPServers: servers},
		{QueueRole: "executor", MCPServers: servers},
		{QueueRole: "supervisor", MCPServers: servers},
		{QueueRole: "validator", VerificationStage: "report", MCPServers: servers},
		{QueueRole: "supervisor-repair", MCPServers: servers},
	}
	for _, in := range roles {
		prompt := BuildSystemPrompt(in)
		for _, want := range []string{"jira", "connexall-confluence", "MCP server", "browser"} {
			if !strings.Contains(prompt, want) {
				t.Errorf("role %q lost MCP policy text %q", in.QueueRole, want)
			}
		}
	}
	if strings.Contains(BuildSystemPrompt(PromptInput{QueueRole: "executor"}), "# MCP servers") {
		t.Error("MCP policy should not appear when no server is connected")
	}
}

// MCP tools are registered Mutating (an external server's side effects are
// unknown), which used to hide every mcp__ tool from an inspection-only review.
// The supervisor then had no credentialed way to read Jira or Confluence and
// reached for the browser instead. This pins the exemption: inspection-only
// roles keep MCP tools, and still lose ordinary mutating tools.
func TestInspectOnlyKeepsMCPTools(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Add(&tools.Tool{Name: "mcp__jira__get_issue", Mutating: true})
	reg.Add(&tools.Tool{Name: "mcp__connexall-confluence__get_page", Mutating: true})
	reg.Add(&tools.Tool{Name: "read_file"})
	reg.Add(&tools.Tool{Name: "write_file", Mutating: true})
	reg.Add(&tools.Tool{Name: "browser_open", Mutating: true})

	supervisor := &Agent{cfg: &config.Config{QueueRole: "supervisor", InspectOnly: true}, registry: reg}
	got := supervisor.toolNames()
	for _, want := range []string{"mcp__jira__get_issue", "mcp__connexall-confluence__get_page", "read_file"} {
		if !strings.Contains(got, want) {
			t.Errorf("inspection-only review lost %s; has: %s", want, got)
		}
	}
	for _, unwanted := range []string{"write_file", "browser_open"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("inspection-only review still sees %s; has: %s", unwanted, got)
		}
	}

	executor := &Agent{cfg: &config.Config{QueueRole: "executor"}, registry: reg}
	if !strings.Contains(executor.toolNames(), "mcp__jira__get_issue") {
		t.Error("executor lost MCP tool access")
	}
}
