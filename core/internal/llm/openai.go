package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// OpenAIProvider targets any /v1/chat/completions endpoint: Ollama, LM Studio,
// vLLM, llama.cpp's server, OpenRouter. Written against raw HTTP because the
// point is to work with whatever local runtime is on the machine, not to bind
// to one vendor's SDK.
type OpenAIProvider struct {
	baseURL   string
	apiKey    string
	model     string
	maxTokens int64
	// effort is sent as top-level "reasoning_effort" when set. Left empty by
	// default: unlike Anthropic, "OpenAI-compatible" spans strict local
	// servers that 4xx on a field they do not recognise (see stream's retry
	// logic below), so this is only ever sent when the user opted in for a
	// role that actually wants it — never assumed.
	effort string
	http   *http.Client
}

func NewOpenAICompat(baseURL, apiKey, model string, maxTokens int64, effort string) *OpenAIProvider {
	if maxTokens <= 0 {
		maxTokens = 8192
	}
	return &OpenAIProvider{
		baseURL:   strings.TrimRight(baseURL, "/"),
		apiKey:    apiKey,
		model:     model,
		maxTokens: maxTokens,
		effort:    strings.ToLower(strings.TrimSpace(effort)),
		// No client timeout. It would cap the whole exchange, which is exactly
		// the thing that must not be capped: a local model can legitimately
		// stream one reply for hours. Liveness is judged from the bytes instead
		// — see wire.go and the agent's idle guard.
		http: &http.Client{},
	}
}

func (p *OpenAIProvider) Name() string  { return "openai-compatible" }
func (p *OpenAIProvider) Model() string { return p.model }

type oaiToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type oaiMessage struct {
	Role       string        `json:"role"`
	Content    any           `json:"content,omitempty"`
	ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
	Name       string        `json:"name,omitempty"`
}

func (p *OpenAIProvider) convert(req Request) []oaiMessage {
	var out []oaiMessage
	if req.System != "" {
		out = append(out, oaiMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case RoleAssistant:
			msg := oaiMessage{Role: "assistant"}
			var text strings.Builder
			for _, b := range m.Blocks {
				switch b.Type {
				case BlockText:
					text.WriteString(b.Text)
				case BlockToolUse:
					tc := oaiToolCall{ID: b.ID, Type: "function"}
					tc.Function.Name = b.Name
					tc.Function.Arguments = string(b.Input)
					if tc.Function.Arguments == "" {
						tc.Function.Arguments = "{}"
					}
					msg.ToolCalls = append(msg.ToolCalls, tc)
					// Thinking blocks have no portable representation here and
					// are dropped rather than leaked into the visible content.
				}
			}
			msg.Content = text.String()
			if msg.Content == "" && len(msg.ToolCalls) == 0 {
				continue
			}
			out = append(out, msg)
		default:
			// Tool results become their own `tool` messages; remaining text
			// becomes one user message.
			var text strings.Builder
			var images []map[string]any
			for _, b := range m.Blocks {
				switch b.Type {
				case BlockImage:
					images = append(images, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + b.MediaType + ";base64," + b.Data}})
				case BlockToolResult:
					out = append(out, oaiMessage{
						Role: "tool", ToolCallID: b.ToolUseID, Content: b.Text,
					})
				case BlockText:
					if text.Len() > 0 {
						text.WriteString("\n\n")
					}
					text.WriteString(b.Text)
				}
			}
			if len(images) > 0 {
				parts := []map[string]any{{"type": "text", "text": text.String()}}
				parts = append(parts, images...)
				out = append(out, oaiMessage{Role: "user", Content: parts})
			} else if text.Len() > 0 {
				out = append(out, oaiMessage{Role: "user", Content: text.String()})
			}
		}
	}
	return out
}

// sanitizeSchema removes null-valued keys and guarantees a well-formed object
// schema. Tool schemas from MCP servers are arbitrary third-party JSON, and a
// stray null makes strict endpoints reject the entire request rather than the
// one offending tool.
func sanitizeSchema(in map[string]any) map[string]any {
	clean := func(v any) any {
		var walk func(any) any
		walk = func(v any) any {
			switch t := v.(type) {
			case map[string]any:
				out := make(map[string]any, len(t))
				for k, val := range t {
					if val == nil {
						continue
					}
					out[k] = walk(val)
				}
				return out
			case []any:
				out := make([]any, 0, len(t))
				for _, val := range t {
					if val == nil {
						continue
					}
					out = append(out, walk(val))
				}
				return out
			default:
				return v
			}
		}
		return walk(v)
	}

	out, _ := clean(in).(map[string]any)
	if out == nil {
		out = map[string]any{}
	}
	if _, ok := out["type"]; !ok {
		out["type"] = "object"
	}
	if _, ok := out["properties"]; !ok {
		out["properties"] = map[string]any{}
	}
	return out
}

// post sends one streaming request and returns the live response.
func (p *OpenAIProvider) post(ctx context.Context, body map[string]any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		p.baseURL+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Accept", "text/event-stream")
	if p.apiKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	resp, err := p.http.Do(hreq)
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s: %w", p.baseURL, err)
	}
	return resp, nil
}

// optionalBodyFields are asks that improve the reply when a server honours
// them but are never required to get one: token usage, and a reasoning-effort
// hint for models that support it. Both are dropped together on retry — see
// stream — because "OpenAI-compatible" spans strict local servers that 4xx on
// any field they do not implement rather than ignoring it.
var optionalBodyFields = []string{"stream_options", "reasoning_effort"}

/*
stream sends the request, dropping the optional fields above and retrying
once if the server will not accept them.

Asking for token counts or a reasoning effort must never cost us the reply
itself, so a 4xx on the first attempt is retried without them: worst case we
lose the token count or the effort hint for that provider, which is exactly
where we were before asking.
*/
func (p *OpenAIProvider) stream(ctx context.Context, body map[string]any) (*http.Response, error) {
	resp, err := p.post(ctx, body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 400 {
		return resp, nil
	}

	first, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	resp.Body.Close()

	var hadOptional bool
	for _, k := range optionalBodyFields {
		if _, ok := body[k]; ok {
			hadOptional = true
			delete(body, k)
		}
	}
	if !hadOptional || resp.StatusCode >= 500 {
		return nil, fmt.Errorf("http %d from %s: %s",
			resp.StatusCode, p.baseURL, strings.TrimSpace(string(first)))
	}

	retry, err := p.post(ctx, body)
	if err != nil {
		return nil, err
	}
	if retry.StatusCode < 400 {
		return retry, nil
	}
	second, _ := io.ReadAll(io.LimitReader(retry.Body, 8192))
	retry.Body.Close()
	return nil, fmt.Errorf("http %d from %s: %s",
		retry.StatusCode, p.baseURL, strings.TrimSpace(string(second)))
}

func (p *OpenAIProvider) Stream(ctx context.Context, req Request, sink func(Event)) (*Turn, error) {
	type toolSpec struct {
		Type     string `json:"type"`
		Function struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			Parameters  map[string]any `json:"parameters"`
		} `json:"function"`
	}
	var tools []toolSpec
	for _, t := range req.Tools {
		var ts toolSpec
		ts.Type = "function"
		ts.Function.Name = t.Name
		ts.Function.Description = t.Description
		schema := sanitizeSchema(t.Schema)
		ts.Function.Parameters = schema
		tools = append(tools, ts)
	}

	body := map[string]any{
		"model":      p.model,
		"messages":   p.convert(req),
		"stream":     true,
		"max_tokens": p.maxTokens,
		// A streamed response carries no usage block unless it is asked for.
		// Without this every OpenAI-compatible provider — which is all of them
		// except Anthropic — reports zero tokens for every turn.
		"stream_options": map[string]any{"include_usage": true},
	}
	if len(tools) > 0 {
		body["tools"] = tools
		body["tool_choice"] = "auto"
	}
	if p.effort != "" {
		// The shorthand OpenAI's own reasoning models and OpenRouter both
		// accept directly on the request body (OpenRouter treats it as
		// equivalent to `reasoning: {effort: ...}` and translates it for
		// whichever backend actually serves the model). A provider that has
		// never heard of it either ignores it or 4xxs, and the latter is
		// handled by stream's retry above.
		body["reasoning_effort"] = p.effort
	}

	resp, err := p.stream(ctx, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	turn := &Turn{Model: p.model}
	var text strings.Builder
	// Tool calls arrive fragmented across chunks, keyed by index.
	calls := map[int]*oaiToolCall{}
	announced := map[int]bool{}

	// Read through a WireReader so every chunk — including the SSE comments a
	// server sends to hold the connection open — counts as proof of life.
	sc := bufio.NewScanner(&WireReader{R: resp.Body, Sink: sink})
	sc.Buffer(make([]byte, 0, 64*1024), 16<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
					// Two spellings for the same thing, because the
					// providers behind this one endpoint shape disagree.
					// DeepSeek's own API (and some vLLM/llama.cpp builds)
					// send "reasoning_content"; OpenRouter normalises every
					// backend it fronts — including that same DeepSeek
					// model — to a bare "reasoning" instead. Missing either
					// one means the entire reasoning stream is silently
					// dropped: not shown as thinking, not counted, gone —
					// while the connection stays busy for however long the
					// model spends thinking, which for a real reasoning
					// model is most of the turn.
					ReasoningContent string        `json:"reasoning_content"`
					Reasoning        string        `json:"reasoning"`
					ToolCalls        []oaiToolCall `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens        int64 `json:"prompt_tokens"`
				CompletionTokens    int64 `json:"completion_tokens"`
				PromptTokensDetails *struct {
					CachedTokens int64 `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if chunk.Usage != nil {
			turn.Usage.Input = chunk.Usage.PromptTokens
			turn.Usage.Output = chunk.Usage.CompletionTokens
			// Note the difference from Anthropic, which reports cache reads
			// *outside* input_tokens: here cached tokens are a subset of
			// prompt_tokens, so the two must never simply be added together.
			if d := chunk.Usage.PromptTokensDetails; d != nil {
				turn.Usage.CacheRead = d.CachedTokens
			}
		}
		for _, ch := range chunk.Choices {
			reasoning := ch.Delta.ReasoningContent
			if reasoning == "" {
				reasoning = ch.Delta.Reasoning
			}
			if reasoning != "" && sink != nil {
				sink(Event{Kind: EventThinking, Text: reasoning})
			}
			if ch.Delta.Content != "" {
				text.WriteString(ch.Delta.Content)
				if sink != nil {
					sink(Event{Kind: EventText, Text: ch.Delta.Content})
				}
			}
			for _, tc := range ch.Delta.ToolCalls {
				cur, ok := calls[tc.Index]
				if !ok {
					cur = &oaiToolCall{Index: tc.Index}
					calls[tc.Index] = cur
				}
				if tc.ID != "" {
					cur.ID = tc.ID
				}
				if tc.Function.Name != "" {
					cur.Function.Name = tc.Function.Name
				}
				cur.Function.Arguments += tc.Function.Arguments
				if cur.Function.Name != "" && !announced[tc.Index] && sink != nil {
					announced[tc.Index] = true
					sink(Event{Kind: EventToolStart, ToolName: cur.Function.Name, ToolID: cur.ID})
				}
			}
			if ch.FinishReason != "" {
				turn.StopReason = ch.FinishReason
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}

	if text.Len() > 0 {
		turn.Blocks = append(turn.Blocks, Block{Type: BlockText, Text: text.String()})
	}
	for i := 0; i < len(calls); i++ {
		c, ok := calls[i]
		if !ok {
			continue
		}
		args := strings.TrimSpace(c.Function.Arguments)
		if args == "" || !json.Valid([]byte(args)) {
			args = "{}"
		}
		id := c.ID
		if id == "" {
			id = fmt.Sprintf("call_%d", i)
		}
		turn.Blocks = append(turn.Blocks, Block{
			Type: BlockToolUse, ID: id, Name: c.Function.Name, Input: json.RawMessage(args),
		})
	}
	// Normalise the stop reason so the agent loop has one vocabulary.
	if len(turn.ToolCalls()) > 0 {
		turn.StopReason = "tool_use"
	} else if turn.StopReason == "stop" {
		turn.StopReason = "end_turn"
	}
	return turn, nil
}
