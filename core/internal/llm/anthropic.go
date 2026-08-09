package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

type AnthropicProvider struct {
	client    anthropic.Client
	model     string
	maxTokens int64
	effort    anthropic.OutputConfigEffort
	thinking  bool
}

func NewAnthropic(apiKey, model, baseURL, effort string, maxTokens int64, thinking bool) *AnthropicProvider {
	// The SDK owns the reads, so liveness has to be observed underneath it: this
	// client wraps every response body in a WireReader on the way back up.
	opts := []option.RequestOption{
		option.WithHTTPClient(&http.Client{Transport: &WireTransport{}}),
	}
	if apiKey != "" {
		opts = append(opts, option.WithAPIKey(apiKey))
	}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	eff := anthropic.OutputConfigEffortXhigh
	switch strings.ToLower(effort) {
	case "low":
		eff = anthropic.OutputConfigEffortLow
	case "medium":
		eff = anthropic.OutputConfigEffortMedium
	case "high":
		eff = anthropic.OutputConfigEffortHigh
	case "max":
		eff = anthropic.OutputConfigEffortMax
	}
	if maxTokens <= 0 {
		maxTokens = 64000
	}
	return &AnthropicProvider{
		client:    anthropic.NewClient(opts...),
		model:     model,
		maxTokens: maxTokens,
		effort:    eff,
		thinking:  thinking,
	}
}

func (p *AnthropicProvider) Name() string  { return "anthropic" }
func (p *AnthropicProvider) Model() string { return p.model }

func (p *AnthropicProvider) toParams(req Request) anthropic.MessageNewParams {
	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(p.model),
		MaxTokens: p.maxTokens,
	}

	// Render order is tools -> system -> messages. Marking the last system
	// block caches the tool definitions and the system prompt together, which
	// is the whole stable prefix.
	if req.System != "" {
		params.System = []anthropic.TextBlockParam{{
			Text:         req.System,
			CacheControl: anthropic.NewCacheControlEphemeralParam(),
		}}
	}

	params.OutputConfig = anthropic.OutputConfigParam{Effort: p.effort}

	if p.thinking {
		// Adaptive with summarized display: the default is "omitted", which
		// makes a streaming UI look frozen during long reasoning.
		params.Thinking = anthropic.ThinkingConfigParamUnion{
			OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{
				Display: anthropic.ThinkingConfigAdaptiveDisplaySummarized,
			},
		}
	} else {
		params.Thinking = anthropic.ThinkingConfigParamUnion{
			OfDisabled: &anthropic.ThinkingConfigDisabledParam{},
		}
	}

	for _, t := range req.Tools {
		props := map[string]any{}
		var required []string
		if t.Schema != nil {
			if p, ok := t.Schema["properties"].(map[string]any); ok {
				props = p
			}
			if r, ok := t.Schema["required"].([]string); ok {
				required = r
			} else if r, ok := t.Schema["required"].([]any); ok {
				for _, v := range r {
					if s, ok := v.(string); ok {
						required = append(required, s)
					}
				}
			}
		}
		tp := anthropic.ToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: props,
				Required:   required,
			},
		}
		params.Tools = append(params.Tools, anthropic.ToolUnionParam{OfTool: &tp})
	}

	for _, m := range req.Messages {
		var blocks []anthropic.ContentBlockParamUnion
		for _, b := range m.Blocks {
			switch b.Type {
			case BlockText:
				if strings.TrimSpace(b.Text) == "" {
					continue
				}
				blocks = append(blocks, anthropic.NewTextBlock(b.Text))
			case BlockThinking:
				// Replayed unchanged, signature included — the API validates it.
				if b.Signature == "" {
					continue
				}
				blocks = append(blocks, anthropic.ContentBlockParamUnion{
					OfThinking: &anthropic.ThinkingBlockParam{
						Thinking:  b.Text,
						Signature: b.Signature,
					},
				})
			case BlockToolUse:
				var input any
				if len(b.Input) > 0 {
					_ = json.Unmarshal(b.Input, &input)
				}
				if input == nil {
					input = map[string]any{}
				}
				blocks = append(blocks, anthropic.ContentBlockParamUnion{
					OfToolUse: &anthropic.ToolUseBlockParam{
						ID:    b.ID,
						Name:  b.Name,
						Input: input,
					},
				})
			case BlockToolResult:
				blocks = append(blocks, anthropic.NewToolResultBlock(b.ToolUseID, b.Text, b.IsError))
			}
		}
		if len(blocks) == 0 {
			continue
		}
		if m.Role == RoleAssistant {
			params.Messages = append(params.Messages, anthropic.NewAssistantMessage(blocks...))
		} else {
			params.Messages = append(params.Messages, anthropic.NewUserMessage(blocks...))
		}
	}

	return params
}

func (p *AnthropicProvider) Stream(ctx context.Context, req Request, sink func(Event)) (*Turn, error) {
	params := p.toParams(req)
	stream := p.client.Messages.NewStreaming(WithWireSink(ctx, sink), params)

	acc := anthropic.Message{}
	announced := map[string]bool{}

	for stream.Next() {
		ev := stream.Current()
		if err := acc.Accumulate(ev); err != nil {
			return nil, fmt.Errorf("accumulating stream: %w", err)
		}
		switch e := ev.AsAny().(type) {
		case anthropic.ContentBlockDeltaEvent:
			switch d := e.Delta.AsAny().(type) {
			case anthropic.TextDelta:
				if d.Text != "" && sink != nil {
					sink(Event{Kind: EventText, Text: d.Text})
				}
			case anthropic.ThinkingDelta:
				if d.Thinking != "" && sink != nil {
					sink(Event{Kind: EventThinking, Text: d.Thinking})
				}
			}
		case anthropic.ContentBlockStartEvent:
			// Announce a tool call as soon as its name is known so the UI can
			// show "running X" before the arguments finish streaming.
			if tu, ok := e.ContentBlock.AsAny().(anthropic.ToolUseBlock); ok {
				if !announced[tu.ID] && sink != nil {
					announced[tu.ID] = true
					sink(Event{Kind: EventToolStart, ToolName: tu.Name, ToolID: tu.ID})
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		return nil, err
	}

	turn := &Turn{
		StopReason: string(acc.StopReason),
		Model:      string(acc.Model),
		Usage: Usage{
			Input:      acc.Usage.InputTokens,
			Output:     acc.Usage.OutputTokens,
			CacheRead:  acc.Usage.CacheReadInputTokens,
			CacheWrite: acc.Usage.CacheCreationInputTokens,
		},
	}
	for _, b := range acc.Content {
		switch v := b.AsAny().(type) {
		case anthropic.TextBlock:
			turn.Blocks = append(turn.Blocks, Block{Type: BlockText, Text: v.Text})
		case anthropic.ThinkingBlock:
			turn.Blocks = append(turn.Blocks, Block{
				Type: BlockThinking, Text: v.Thinking, Signature: v.Signature,
			})
		case anthropic.ToolUseBlock:
			input := v.Input
			if len(input) == 0 {
				input = json.RawMessage(`{}`)
			}
			turn.Blocks = append(turn.Blocks, Block{
				Type: BlockToolUse, ID: v.ID, Name: v.Name, Input: input,
			})
			if !announced[v.ID] && sink != nil {
				sink(Event{Kind: EventToolStart, ToolName: v.Name, ToolID: v.ID})
			}
		}
	}
	return turn, nil
}
