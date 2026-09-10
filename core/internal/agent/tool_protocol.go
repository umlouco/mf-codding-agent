package agent

import (
	"encoding/json"
	"strings"

	"github.com/mflores/mfagent/core/internal/llm"
)

// An arguments-only command is not a tool call. Ask its author to name the
// intended tool; never infer a shell or execute an anonymous command ourselves.
func unnamedCommandProposal(text string, definitions []llm.ToolDef) bool {
	if strings.Contains(text, "```") {
		return false
	}
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return false
	}
	var args map[string]json.RawMessage
	if json.Unmarshal([]byte(text[start:]), &args) != nil || len(args) == 0 || len(args) > 2 {
		return false
	}
	for key := range args {
		if key != "command" && key != "description" {
			return false
		}
	}
	var command string
	if json.Unmarshal(args["command"], &command) != nil || strings.TrimSpace(command) == "" {
		return false
	}
	for _, definition := range definitions {
		if definition.Name == "run_shell" {
			return true
		}
	}
	return false
}

const unnamedCommandCorrection = `The command arguments in your response were not executed: no tool was named.
Use the native tool interface with an explicit tool name and arguments. For a foreground shell
command, call run_shell. If your interface emits textual tool envelopes, use exactly
{"tool_calls":[{"name":"run_shell","arguments":{"command":"the actual command","description":"its purpose"}}]}.
Check the intended command before submitting it. In PowerShell, literal backslash-n text is not
a command separator; use actual newlines or valid PowerShell separators. Do not output only
arguments again. If no tool is needed, return the required executor completion report instead.`
