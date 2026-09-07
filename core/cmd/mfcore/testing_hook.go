package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

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
	root, _ := os.Getwd()
	env := &tools.Env{Root: root, QueueRole: os.Getenv("MFAGENT_QUEUE_ROLE"), Testing: tools.TestingFromEnvironment()}
	name := strings.ToLower(event.Name)
	mutating := !strings.Contains(name, "read") && !strings.Contains(name, "glob") && !strings.Contains(name, "grep") && !strings.HasSuffix(name, "_list") && !strings.HasSuffix(name, "_stats")
	if err := env.CheckQueueOwnership(event.Name, event.Input, mutating); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	env.MarkTestingOpened()
	if err := env.CheckTestingTool(event.Name, event.Input); err != nil {
		fmt.Fprintln(stderr, env.RedactTestingSecrets(err.Error()))
		return 2
	}
	return 0
}
