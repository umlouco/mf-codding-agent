package llm

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// Some local chat templates emit a tool envelope as assistant content. Accept
// only a complete, exclusive envelope naming advertised tools. Execution still
// goes through the ordinary registry, role checks and tool-result protocol.
func recoverTextToolCalls(text string, definitions []ToolDef) ([]Block, string) {
	if len(definitions) == 0 || strings.Contains(text, "```") {
		return nil, text
	}
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return nil, text
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal([]byte(text[start:]), &envelope) != nil || len(envelope) != 1 {
		return nil, text
	}
	var proposed []struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(envelope["tool_calls"], &proposed) != nil || len(proposed) == 0 {
		return nil, text
	}
	known := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		known[definition.Name] = true
	}
	calls := make([]Block, 0, len(proposed))
	for _, proposal := range proposed {
		if !known[proposal.Name] {
			return nil, text
		}
		args := proposal.Arguments
		var encoded string
		if json.Unmarshal(args, &encoded) == nil {
			args = json.RawMessage(encoded)
		}
		var object map[string]json.RawMessage
		if json.Unmarshal(args, &object) != nil || object == nil {
			return nil, text
		}
		var nonce [12]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return nil, text
		}
		calls = append(calls, Block{Type: BlockToolUse, ID: "text_call_" + hex.EncodeToString(nonce[:]),
			Name: proposal.Name, Input: args})
	}
	return calls, strings.TrimSpace(text[:start])
}
