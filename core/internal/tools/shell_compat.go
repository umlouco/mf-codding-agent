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

func powerShellRecoveryHint(command, output string) string {
	if strings.Contains(output, "InvalidEndOfLine") && strings.Contains(command, "||") {
		return "\nRecovery: this PowerShell version does not support ||. Send the complete POSIX command to the unix tool, which supports &&, ||, pipelines and native build tools on Windows. This parser error occurred before commands ran; it is not an application failure."
	}
	if strings.Contains(output, "DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand") && strings.Contains(command, "mkdir") {
		return "\nRecovery: PowerShell mkdir reported an existing directory. POSIX mkdir -p is idempotent; send that command to the unix tool, or use New-Item -ItemType Directory -Force in PowerShell. Preserve the existing directory and its contents."
	}
	if strings.Contains(output, "here-string header") {
		return "\nRecovery: a PowerShell here-string header must be followed by an actual newline, not literal backtick-n or backslash-n text. Use write_file with path and content to create source files without shell quoting or encoding changes. A generated recovery task's suggested shell command is not a requirement to keep repeating broken syntax."
	}
	if strings.Contains(strings.ToLower(command), "curl") && strings.Contains(output, "Invoke-WebRequest") {
		return "\nRecovery: PowerShell resolved curl to Invoke-WebRequest. Use curl.exe for curl CLI flags, or use the unix tool for a POSIX pipeline. Repeating the same curl flags in PowerShell will repeat this error."
	}
	if strings.Contains(output, "CommandNotFoundException") {
		for _, name := range []string{"head", "tail", "grep", "sed", "awk"} {
			if strings.Contains(output, name+" :") {
				return "\nRecovery: this command uses POSIX text tools in PowerShell. Send the pipeline to the unix tool, which implements these tools on Windows, or translate it into PowerShell cmdlets."
			}
		}
	}
	return ""
}

// powerShellCompatible accepts the most common cross-platform command chain.
// Models, package documentation and task verification commands frequently use
// `&&`; Windows PowerShell 5 rejects it before running either command. Rewriting
// only unquoted separators preserves the expected stop-on-error behaviour while
// leaving string literals and Python/Node snippets untouched.
func powerShellCompatible(command string) string {
	var out strings.Builder
	out.Grow(len(command) + 64)
	var single, double, escaped bool
	var hereQuote byte
	for i := 0; i < len(command); i++ {
		ch := command[i]
		if hereQuote != 0 {
			out.WriteByte(ch)
			if ch == hereQuote && i+1 < len(command) && command[i+1] == '@' && (i == 0 || command[i-1] == '\n') {
				out.WriteByte('@')
				i++
				hereQuote = 0
			}
			continue
		}
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
		if ch == '@' && !single && !double && i+1 < len(command) && (command[i+1] == '\'' || command[i+1] == '"') {
			next := i + 2
			for next < len(command) && (command[next] == ' ' || command[next] == '\t') {
				next++
			}
			if next < len(command) && (command[next] == '\r' || command[next] == '\n') {
				hereQuote = command[i+1]
				out.WriteByte(ch)
				out.WriteByte(hereQuote)
				i++
				continue
			}
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
	if !strings.Contains(trimmed, "#< CLIXML") && !strings.HasPrefix(trimmed, "<Objs ") {
		return output
	}
	start := strings.Index(trimmed, "<Objs ")
	end := strings.Index(trimmed, "</Objs>")
	if start < 0 || end < start {
		return output
	}
	end += len("</Objs>")
	// Combined stdout/stderr can put ordinary command output between the
	// CLIXML marker and the XML document. Never discard that actual evidence.
	prefix := strings.TrimSpace(strings.ReplaceAll(trimmed[:start], "#< CLIXML", ""))
	suffix := strings.TrimSpace(trimmed[end:])
	trimmed = trimmed[start:end]
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
	lines := make([]string, 0, len(values))
	if prefix != "" {
		lines = append(lines, prefix)
	}
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
	if suffix != "" {
		lines = append(lines, cleanPowerShellOutput(suffix))
	}
	return strings.Join(lines, "\n")
}
