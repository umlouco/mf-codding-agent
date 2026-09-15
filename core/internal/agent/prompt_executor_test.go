package agent

import (
	"strings"
	"testing"
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
