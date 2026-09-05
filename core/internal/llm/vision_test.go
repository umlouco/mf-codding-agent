package llm

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestVisionPayloadKeepsImageForBothTransports(t *testing.T) {
	req := Request{Messages: []Message{{Role: RoleUser, Blocks: []Block{{Type: BlockText, Text: "Check layout"}, {Type: BlockImage, MediaType: "image/png", Data: "aW1hZ2U="}}}}}
	openai := NewOpenAICompat("http://unused", "", "vision", 1000, "")
	anthropic := NewAnthropic("", "vision", "http://unused", "low", 1000, false)
	for name, payload := range map[string]any{"openai": openai.convert(req), "anthropic": anthropic.toParams(req)} {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "aW1hZ2U=") || !strings.Contains(string(data), "image/png") {
			t.Fatalf("%s dropped image: %s", name, data)
		}
	}
	textOnly := openai.convert(Request{Messages: []Message{UserText("hello")}})
	if textOnly[0].Content != "hello" {
		t.Fatal("text-only compatibility changed")
	}
}
