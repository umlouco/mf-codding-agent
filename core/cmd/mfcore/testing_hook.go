package main

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/mflores/mfagent/core/internal/tools"
)

// Claude CLI invokes this before tools, using the same target policy as native workers.
// A fresh hook process has no browser-session state, so it enforces the origin;
// native browser sessions additionally require the exact initial URL.
func runTestingHook(input io.Reader, stderr io.Writer) int {
	var event struct {
		Name  string          `json:"tool_name"`
		Input json.RawMessage `json:"tool_input"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 2*1024*1024)).Decode(&event); err != nil {
		fmt.Fprintln(stderr, "Testing environment: invalid tool hook input.")
		return 2
	}
	env := &tools.Env{Testing: tools.TestingFromEnvironment()}
	env.MarkTestingOpened()
	if err := env.CheckTestingTool(event.Name, event.Input); err != nil {
		fmt.Fprintln(stderr, env.RedactTestingSecrets(err.Error()))
		return 2
	}
	return 0
}
