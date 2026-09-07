package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCLITestingHook(t *testing.T) {
	t.Setenv("MFAGENT_TEST_URL", "https://app.example.test/")
	for _, tc := range []struct {
		input string
		code  int
	}{
		{`{"tool_name":"Bash","tool_input":{"command":"python -m http.server 8080"}}`, 2},
		{`{"tool_name":"PowerShell","tool_input":{"command":"php -S 127.0.0.1:8080"}}`, 2},
		{`{"tool_name":"Bash","tool_input":{"command":"go test ./..."}}`, 0},
		{`{"tool_name":"mcp__browser__navigate_page","tool_input":{"url":"http://localhost:8080/"}}`, 2},
		{`{"tool_name":"mcp__browser__navigate_page","tool_input":{"url":"https://app.example.test/login"}}`, 0},
		{`invalid`, 2},
	} {
		var output bytes.Buffer
		if got := runTestingHook(strings.NewReader(tc.input), &output); got != tc.code {
			t.Fatalf("got %d want %d: %s", got, tc.code, output.String())
		}
	}
}

func TestCLIQueueOwnershipWithoutTestingURL(t *testing.T) {
	t.Setenv("MFAGENT_TEST_URL", "")
	t.Setenv("MFAGENT_QUEUE_ROLE", "executor")
	for _, tc := range []struct {
		input string
		code  int
	}{
		{`{"tool_name":"mcp__mfagent__task_queue_update","tool_input":{"id":29,"description":"weaker task"}}`, 2},
		{`{"tool_name":"mcp__mfagent__task_queue_list","tool_input":{}}`, 0},
		{`{"tool_name":"Bash","tool_input":{"command":"sqlite3 .mfagent/queue.db"}}`, 2},
		{`{"tool_name":"Bash","tool_input":{"command":"node --check playwright-tests/form.spec.js"}}`, 0},
	} {
		var out bytes.Buffer
		if got := runTestingHook(strings.NewReader(tc.input), &out); got != tc.code {
			t.Fatalf("got %d want %d: %s", got, tc.code, out.String())
		}
	}
}
