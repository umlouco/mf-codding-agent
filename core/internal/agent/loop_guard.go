package agent

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/mflores/mfagent/core/internal/llm"
)

const repeatedToolFailureLimit = 3
const toolFailureWindow = 8

var browserErrorLocation = regexp.MustCompile(`\(\d+:\d+\)`)

// toolFailureLoop stops a model from spending its whole round budget repeating
// a tool call that fails in the same way. Inputs are deliberately not part of
// the signature: broken quoting often grows on every retry while the useful
// signal -- tool name plus terminal error -- stays identical.
type toolFailureLoop struct {
	rounds []map[string]bool
}

func (g *toolFailureLoop) observe(calls, results []llm.Block) (bool, string) {
	if len(calls) == 0 || len(calls) != len(results) {
		g.reset()
		return false, ""
	}

	failures := make(map[string]bool)
	for i, result := range results {
		if !result.IsError {
			continue
		}
		detail := terminalError(result.Text)
		if calls[i].Name == "browser_eval" {
			// Changing quote positions does not make the syntax failure new.
			detail = browserErrorLocation.ReplaceAllString(detail, "(line:column)")
		}
		failures[calls[i].Name+": "+detail] = true
	}
	g.rounds = append(g.rounds, failures)
	if len(g.rounds) > toolFailureWindow {
		g.rounds = g.rounds[1:]
	}
	for signature := range failures {
		count := 0
		for _, round := range g.rounds {
			if round[signature] {
				count++
			}
		}
		if count >= repeatedToolFailureLimit {
			return true, fmt.Sprintf("the same tool failure occurred in %d of the last %d rounds: %s", count, len(g.rounds), signature)
		}
	}
	return false, ""
}

func (g *toolFailureLoop) reset() {
	g.rounds = nil
}

func terminalError(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line != "" {
			if len(line) > 300 {
				return line[:300]
			}
			return line
		}
	}
	return "unknown error"
}
