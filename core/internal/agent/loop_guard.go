package agent

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/mflores/mfagent/core/internal/llm"
)

// Detect consecutive re-observation of an unchanged target. Explicit waiting
// tools and mutations are excluded: a legitimate wait or repeated write is not
// evidence that an inspection loop is stuck.
type unchangedToolLoop struct {
	signature [32]byte
	count     int
}

func (g *unchangedToolLoop) observe(calls, results []llm.Block) (warn, stop bool, detail string) {
	if len(calls) != 1 || len(results) != 1 || results[0].IsError {
		g.count = 0
		return
	}
	switch calls[0].Name {
	case "browser_open", "browser_read", "browser_elements", "read_file", "list_dir", "glob", "grep", "project_info", "testing_environment":
	default:
		g.count = 0
		return
	}
	var input any
	if json.Unmarshal(calls[0].Input, &input) != nil {
		g.count = 0
		return
	}
	canonical, _ := json.Marshal(input)
	signature := sha256.Sum256([]byte(calls[0].Name + "\x00" + string(canonical) + "\x00" + results[0].Text))
	if signature == g.signature {
		g.count++
	} else {
		g.signature, g.count = signature, 1
	}
	if g.count >= 3 {
		detail = fmt.Sprintf("%s has returned the same result for the same input %d consecutive times, without an intervening action. Inspect the current state and take the missing action instead of repeating this observation. For an intentional wait, use the dedicated waiting tools", calls[0].Name, g.count)
		if calls[0].Name == "browser_open" {
			detail += ". Reopening a page resets unsaved form input"
		}
	}
	return g.count == 3, g.count >= 5, detail
}

const repeatedToolFailureLimit = 3
const toolFailureWindow = 8

var browserErrorLocation = regexp.MustCompile(`\(\d+:\d+\)`)
var diagnosticHeading = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9_]*(?:Error|Exception)|Error|error(?:\[[^\]]+\])?|panic|fatal(?: error)?):\s*\S`)
var ansiStyle = regexp.MustCompile("\x1b\\[[0-9;]*m")

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
	lines := strings.Split(strings.TrimSpace(ansiStyle.ReplaceAllString(output, "")), "\n")
	// Test runners end every failure with the same test name/footer. That is
	// not the failure: a corrected URL error followed by a form timeout is
	// progress, even when both are reported under one test title.
	for _, raw := range lines {
		if at := strings.Index(raw, "FullyQualifiedErrorId :"); at >= 0 {
			return strings.TrimSpace(raw[at:])
		}
	}
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if !diagnosticHeading.MatchString(line) {
			continue
		}
		for j := i + 1; j < len(lines) && j < i+9; j++ {
			contextLine := strings.TrimSpace(lines[j])
			if strings.HasPrefix(contextLine, "- waiting for locator(") {
				line += " | " + contextLine
				break
			}
		}
		if len(line) > 600 {
			line = line[:600]
		}
		return line
	}
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
