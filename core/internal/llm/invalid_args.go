package llm

import (
	"encoding/json"
	"fmt"
)

// InvalidArgumentsKey marks a tool call whose streamed arguments were not valid
// JSON. The call is kept (the transcript must still pair it with a result) but
// its input is replaced by a small valid object carrying this marker, so the
// agent can refuse it with an explanation instead of running the tool on "{}".
//
// Silently substituting "{}" is what produced three consecutive
// `run_script({})` → "needs at least one step" rounds: the model had sent a
// large batch whose JSON was truncated, and the reply it got back told it
// nothing about why.
const InvalidArgumentsKey = "__mfagent_invalid_arguments"

// InvalidArgumentsInput builds the marker object for raw, unparseable arguments.
func InvalidArgumentsInput(raw string) string {
	var probe any
	detail := "not valid JSON"
	if err := json.Unmarshal([]byte(raw), &probe); err != nil {
		detail = err.Error()
	}
	tail := raw
	if len(tail) > 120 {
		tail = "…" + tail[len(tail)-120:]
	}
	encoded, _ := json.Marshal(map[string]any{
		InvalidArgumentsKey: fmt.Sprintf("%d bytes; %s; ends with: %s", len(raw), detail, tail),
	})
	return string(encoded)
}

// InvalidArguments reports the marker detail when input is a replaced call.
func InvalidArguments(input json.RawMessage) (string, bool) {
	if len(input) == 0 || input[0] != '{' {
		return "", false
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(input, &probe) != nil || len(probe) != 1 {
		return "", false
	}
	raw, ok := probe[InvalidArgumentsKey]
	if !ok {
		return "", false
	}
	var detail string
	_ = json.Unmarshal(raw, &detail)
	return detail, true
}
