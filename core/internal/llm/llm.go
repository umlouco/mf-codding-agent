// Package llm is a provider-agnostic streaming chat interface with tool use.
//
// Two backends are supported: Anthropic via the official Go SDK, and any
// OpenAI-compatible /v1/chat/completions endpoint (Ollama, LM Studio, vLLM,
// OpenRouter). The agent loop is written against this interface only.
package llm

import (
	"context"
	"encoding/json"
	"strings"
)

type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Block types.
const (
	BlockText       = "text"
	BlockImage      = "image"
	BlockThinking   = "thinking"
	BlockToolUse    = "tool_use"
	BlockToolResult = "tool_result"
)

type Block struct {
	Type string `json:"type"`

	Text      string `json:"text,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	Data      string `json:"data,omitempty"` // base64 image, sent only to the vision provider
	// Signature must be round-tripped verbatim on thinking blocks; the API
	// rejects tampering.
	Signature string `json:"signature,omitempty"`

	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`

	ToolUseID string `json:"toolUseId,omitempty"`
	IsError   bool   `json:"isError,omitempty"`
}

type Message struct {
	Role   Role    `json:"role"`
	Blocks []Block `json:"blocks"`
}

func UserText(s string) Message {
	return Message{Role: RoleUser, Blocks: []Block{{Type: BlockText, Text: s}}}
}

type ToolDef struct {
	Name        string
	Description string
	Schema      map[string]any
}

// Event kinds emitted while streaming.
const (
	EventText      = "text"
	EventThinking  = "thinking"
	EventToolStart = "tool_start"
	// EventWire reports bytes arriving off the socket, including the framing
	// and keep-alives that never become text. It is a liveness signal rather
	// than content: see wire.go.
	EventWire = "wire"
)

type Event struct {
	Kind     string
	Text     string
	ToolName string
	ToolID   string
	// Bytes carries the size of the read that produced an EventWire.
	Bytes int
}

type Usage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	// OpenAI-compatible prompt_tokens already includes cache hits. Anthropic
	// reports them separately. Keep billing counters unchanged, but carry the
	// distinction into the per-turn context guard.
	InputIncludesCache bool `json:"-"`
}

func (u Usage) ContextTokens() int64 {
	if u.InputIncludesCache {
		return u.Input
	}
	return u.Input + u.CacheRead + u.CacheWrite
}

type Turn struct {
	Blocks     []Block `json:"blocks"`
	StopReason string  `json:"stopReason"`
	Usage      Usage   `json:"usage"`
	Model      string  `json:"model"`
}

func (t *Turn) ToolCalls() []Block {
	var out []Block
	for _, b := range t.Blocks {
		if b.Type == BlockToolUse {
			out = append(out, b)
		}
	}
	return out
}

func (t *Turn) Text() string {
	var s string
	for _, b := range t.Blocks {
		if b.Type == BlockText {
			s += b.Text
		}
	}
	return s
}

type Request struct {
	System   string
	Messages []Message
	Tools    []ToolDef
}

type Provider interface {
	Name() string
	Model() string
	Stream(ctx context.Context, req Request, sink func(Event)) (*Turn, error)
}

// NewProvider creates a concrete Provider from a type string. All known types
// are openai-compatible under the hood; "anthropic" routes through the
// Anthropic SDK, everything else hits /v1/chat/completions.
func NewProvider(providerType, baseURL, apiKey, model string, maxTokens int64, effort, thinking string) Provider {
	switch strings.ToLower(providerType) {
	case "anthropic":
		return NewAnthropic(apiKey, model, baseURL, effort, maxTokens, strings.EqualFold(thinking, "adaptive"))
	default:
		return NewOpenAICompat(baseURL, apiKey, model, maxTokens, effort)
	}
}

// Embedder generates a vector embedding for a single text input. The returned
// slice is held by the caller and may be reused.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
	Model() string
}
