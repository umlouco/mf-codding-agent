package agent

import (
	"strings"
	"testing"
)

// The supervisor orchestrates and never edits; the test-repair worker edits
// tests and never owns the task list. Folding the repair worker into the
// supervisor policy told an editing worker to split and delete tasks it has no
// way to touch, so the two prompts must stay distinct.
func TestSupervisorAndRepairWorkerPromptsStaySeparate(t *testing.T) {
	supervisor := BuildSystemPrompt(PromptInput{QueueRole: "supervisor", WorkspaceRoot: "/w"})
	repair := BuildSystemPrompt(PromptInput{QueueRole: "supervisor-repair", WorkspaceRoot: "/w"})

	for _, want := range []string{"orchestrator", "inspection-only", "tester", "coder"} {
		if !strings.Contains(supervisor, want) {
			t.Errorf("supervisor prompt is missing %q", want)
		}
	}
	if !strings.Contains(repair, "You are not the supervisor") {
		t.Error("repair worker must be told it is not the supervisor")
	}
	if strings.Contains(repair, "orchestrator") || strings.Contains(repair, "Split") {
		t.Error("repair worker must not receive the supervisor's task-list authority")
	}
}

func TestTesterAgentStageRunsChecksItself(t *testing.T) {
	prompt := BuildSystemPrompt(PromptInput{QueueRole: "validator", VerificationStage: "agent", WorkspaceRoot: "/w"})
	for _, want := range []string{"independent tester", "browser tools", "read-only", "INCOMPLETE"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("tester prompt is missing %q", want)
		}
	}
	if strings.Contains(prompt, "The host\nwill execute these proposed checks") {
		t.Error("the agent stage must not use the plan-only prompt")
	}
}
