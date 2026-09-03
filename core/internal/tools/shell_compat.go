package tools

import (
	"encoding/xml"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const powerShellAndGuard = "; if (-not $?) { " +
	"if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }; "

// powerShellCompatible accepts the most common cross-platform command chain.
// Models, package documentation and task verification commands frequently use
// `&&`; Windows PowerShell 5 rejects it before running either command. Rewriting
// only unquoted separators preserves the expected stop-on-error behaviour while
// leaving string literals and Python/Node snippets untouched.
func powerShellCompatible(command string) string {
	var out strings.Builder
	out.Grow(len(command) + 64)
	var single, double, escaped bool
	for i := 0; i < len(command); i++ {
		ch := command[i]
		if escaped {
			out.WriteByte(ch)
			escaped = false
			continue
		}
		if ch == '`' && !single {
			out.WriteByte(ch)
			escaped = true
			continue
		}
		if ch == '\'' && !double {
			single = !single
			out.WriteByte(ch)
			continue
		}
		if ch == '"' && !single {
			double = !double
			out.WriteByte(ch)
			continue
		}
		if ch == '&' && i+1 < len(command) && command[i+1] == '&' && !single && !double {
			out.WriteString(powerShellAndGuard)
			i++
			continue
		}
		out.WriteByte(ch)
	}
	return out.String()
}

var powerShellEscapedRune = regexp.MustCompile(`(?i)_x([0-9a-f]{4})_`)

// cleanPowerShellOutput turns the CLIXML written by Windows PowerShell's error
// stream into the same plain text that a user sees in a terminal. Feeding the
// XML envelope back to the model hides the actionable parser error and makes
// repeated failures much more likely.
func cleanPowerShellOutput(output string) string {
	trimmed := strings.TrimSpace(output)
	if strings.HasPrefix(trimmed, "#< CLIXML") {
		if start := strings.Index(trimmed, "<Objs "); start >= 0 {
			trimmed = trimmed[start:]
		}
	}
	if !strings.HasPrefix(trimmed, "<Objs ") {
		return output
	}
	var values []string
	decoder := xml.NewDecoder(strings.NewReader(trimmed))
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return output
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "S" {
			continue
		}
		var value string
		if err := decoder.DecodeElement(&value, &start); err != nil {
			return output
		}
		values = append(values, value)
	}
	if len(values) == 0 {
		return output
	}
	lines := make([]string, 0, len(values))
	for _, value := range values {
		value = powerShellEscapedRune.ReplaceAllStringFunc(value, func(token string) string {
			var n rune
			for _, ch := range token[2:6] {
				n <<= 4
				switch {
				case ch >= '0' && ch <= '9':
					n += ch - '0'
				case ch >= 'a' && ch <= 'f':
					n += ch - 'a' + 10
				case ch >= 'A' && ch <= 'F':
					n += ch - 'A' + 10
				}
			}
			if !utf8.ValidRune(n) {
				return token
			}
			return string(n)
		})
		if value = strings.TrimSpace(value); value != "" {
			lines = append(lines, value)
		}
	}
	return strings.Join(lines, "\n")
}
