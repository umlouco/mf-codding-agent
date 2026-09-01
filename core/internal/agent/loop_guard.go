package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/mflores/mfagent/core/internal/llm"
)

const repeatedToolFailureLimit = 3

// toolFailureLoop stops a model from spending its whole round budget repeating
// a tool call that fails in the same way. Inputs are deliberately not part of
// the signature: broken quoting often grows on every retry while the useful
// signal -- tool name plus terminal error -- stays identical.
type toolFailureLoop struct {
	signature string
	count     int
}

func (g *toolFailureLoop) observe(calls, results []llm.Block) (bool, string) {
	if len(calls) == 0 || len(calls) != len(results) {
		g.reset()
		return false, ""
	}

	parts := make([]string, len(results))
	for i, result := range results {
		if !result.IsError {
			g.reset()
			return false, ""
		}
		parts[i] = calls[i].Name + ": " + terminalError(result.Text)
	}

	signature := strings.Join(parts, " | ")
	if signature == g.signature {
		g.count++
	} else {
		g.signature, g.count = signature, 1
	}
	return g.count >= repeatedToolFailureLimit,
		fmt.Sprintf("the same tool failure occurred %d times: %s", g.count, signature)
}

func (g *toolFailureLoop) reset() {
	g.signature = ""
	g.count = 0
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

func (a *Agent) repeatedFailureReport(
	ctx context.Context,
	req SendRequest,
	sess *Session,
	system string,
	rounds int,
	accumulated string,
	detail string,
) (*SendResult, error) {
	result, err := a.finalReport(ctx, req, sess, system, rounds, accumulated)
	if result == nil || err != nil {
		return result, err
	}
	result.StopReason = "repeated_tool_error"
	result.Text = fmt.Sprintf(
		"[stopped a repeated tool failure after %d rounds: %s]\n\n%s",
		rounds, detail, result.Text)
	return result, nil
}
