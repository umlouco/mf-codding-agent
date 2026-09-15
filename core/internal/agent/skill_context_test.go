package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/config"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/tools"
)

type captureSkillProvider struct{ requests []llm.Request }

func (p *captureSkillProvider) Name() string  { return "fixture" }
func (p *captureSkillProvider) Model() string { return "fixture" }
func (p *captureSkillProvider) Stream(ctx context.Context, request llm.Request, sink func(llm.Event)) (*llm.Turn, error) {
	p.requests = append(p.requests, request)
	return &llm.Turn{Blocks: []llm.Block{{Type: llm.BlockText, Text: "done"}}, StopReason: "end_turn"}, nil
}

func TestWordPressBodiesAreScopedToCurrentTurn(t *testing.T) {
	home := t.TempDir()
	revision := strings.Repeat("a", 40)
	root := filepath.Join(home, revision, "skills", "wp-rest-api")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	for file, body := range map[string]string{
		filepath.Join(home, "active.json"):             `{"revision":"` + revision + `"}`,
		filepath.Join(home, revision, "manifest.json"): `{"revision":"` + revision + `","skills":[{"name":"wp-rest-api"}]}`,
		filepath.Join(root, "SKILL.md"):                "UNIQUE_WORDPRESS_REST_INSTRUCTIONS",
	} {
		if err := os.WriteFile(file, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("MFAGENT_WORDPRESS_SKILLS_BUNDLED", home)
	t.Setenv("MFAGENT_WORDPRESS_SKILLS_HOME", "")
	provider := &captureSkillProvider{}
	cfg := &config.Config{MaxIterations: 2}
	agent := New(cfg, provider, tools.NewRegistry(), &tools.Env{Root: t.TempDir()}, func(string, any) {}, "base system")
	for _, text := range []string{"Fix a WordPress REST endpoint", "Fix a Go parser"} {
		if _, err := agent.Send(context.Background(), SendRequest{SessionID: "same-session", Text: text}); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(provider.requests[0].System, "UNIQUE_WORDPRESS_REST_INSTRUCTIONS") {
		t.Fatal("needed skill not injected")
	}
	if strings.Contains(provider.requests[1].System, "UNIQUE_WORDPRESS_REST_INSTRUCTIONS") {
		t.Fatal("prior skill leaked into unrelated turn")
	}
	for _, message := range agent.Session("same-session").Messages {
		for _, block := range message.Blocks {
			if strings.Contains(block.Text, "UNIQUE_WORDPRESS_REST_INSTRUCTIONS") {
				t.Fatal("auto skill body persisted in history")
			}
		}
	}
	cfg.QueueRole = "executor"
	focus := "Fix a Go parser"
	if _, err := agent.Send(context.Background(), SendRequest{SessionID: "queue", Text: "Original goal: WordPress REST API. History: wp-rest-api", SkillTask: &focus}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(provider.requests[2].System, "UNIQUE_WORDPRESS_REST_INSTRUCTIONS") {
		t.Fatal("history/goal contaminated task selection")
	}
	cfg.ResponseOnly = true
	focus = "WordPress REST endpoint"
	if _, err := agent.Send(context.Background(), SendRequest{SessionID: "format", Text: focus, SkillTask: &focus}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(provider.requests[3].System, "UNIQUE_WORDPRESS_REST_INSTRUCTIONS") {
		t.Fatal("format-only turn got skills")
	}
}

func TestWordPressResourceHistoryIsBoundedWithoutChangingReceipts(t *testing.T) {
	var messages []llm.Message
	for _, id := range []string{"old", "one", "two", "three"} {
		messages = append(messages, llm.Message{Role: llm.RoleAssistant, Blocks: []llm.Block{{Type: llm.BlockToolUse, ID: id, Name: "wordpress_skill"}}},
			llm.Message{Role: llm.RoleUser, Blocks: []llm.Block{{Type: llm.BlockToolResult, ToolUseID: id, Text: "resource-" + id}, {Type: llm.BlockToolResult, ToolUseID: "test-" + id, Text: "test evidence"}}})
	}
	out := boundWordPressResources(messages, 2)
	for _, i := range []int{1, 3} {
		if !strings.Contains(out[i].Blocks[0].Text, "omitted") {
			t.Fatal("old resource still in active context")
		}
	}
	for _, i := range []int{5, 7} {
		if out[i].Blocks[0].Text != messages[i].Blocks[0].Text {
			t.Fatal("latest resources removed")
		}
	}
	for _, i := range []int{1, 3, 5, 7} {
		if strings.Contains(messages[i].Blocks[0].Text, "omitted") || out[i].Blocks[1].Text != "test evidence" {
			t.Fatal("durable history or non-skill evidence changed")
		}
	}
	for _, message := range boundWordPressResources(messages, len(messages)) {
		for _, block := range message.Blocks {
			if strings.HasPrefix(block.Text, "resource-") {
				t.Fatal("resource leaked into new turn")
			}
		}
	}
}

func TestWordPressRoutingIgnoresBackgroundEditorTabs(t *testing.T) {
	request := SendRequest{OpenFiles: []string{"block.json", "theme.json", "parser.go"}}
	paths := skillFocusPaths(request, "Fix parser.go")
	if len(paths) != 1 || paths[0] != "parser.go" {
		t.Fatalf("background tabs polluted intent: %v", paths)
	}
	request.Selection = "selected block attributes"
	request.SelectionPath = "block.json"
	if paths := skillFocusPaths(request, "Fix this selection"); len(paths) != 1 || paths[0] != "block.json" {
		t.Fatalf("selection path lost: %v", paths)
	}
}
