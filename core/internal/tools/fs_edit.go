package tools

import (
	"fmt"
	"strings"
)

func normalizeEOL(text string) string {
	return strings.ReplaceAll(text, "\r\n", "\n")
}

func firstEOL(text string) string {
	i := strings.IndexByte(text, '\n')
	if i < 0 {
		return ""
	}
	if i > 0 && text[i-1] == '\r' {
		return "\r\n"
	}
	return "\n"
}

// replaceIn matches the LF-normalized text exposed by read_file, but applies
// replacements to original byte ranges. Keep in sync with src/textEdits.ts
// and testdata/edit_cases.json. Whitespace other than CRLF/LF remains exact.
func replaceIn(text, oldStr, newStr string, all bool) (string, int, error) {
	oldStr, newStr = normalizeEOL(oldStr), normalizeEOL(newStr)
	if oldStr == "" {
		return "", 0, fmt.Errorf("old_string must not be empty")
	}
	if oldStr == newStr {
		return "", 0, fmt.Errorf("old_string and new_string are identical")
	}
	normalized := normalizeEOL(text)
	count := strings.Count(normalized, oldStr)
	if count == 0 {
		return "", 0, fmt.Errorf("old_string not found; read_file the current file, then copy a smaller unique exact block without line numbers. For a deliberate full-file replacement, use write_file after reading it. No change was applied")
	}
	if count > 1 && !all {
		return "", 0, fmt.Errorf("old_string appears %d times; add surrounding context or set replace_all", count)
	}

	// Map ordered, non-overlapping boundaries in one forward pass, avoiding a
	// per-byte offset table and leaving all bytes outside the matches intact.
	rawOffset, normalizedOffset := 0, 0
	originalOffset := func(offset int) int {
		for normalizedOffset < offset {
			if text[rawOffset] == '\r' && rawOffset+1 < len(text) && text[rawOffset+1] == '\n' {
				rawOffset += 2
			} else {
				rawOffset++
			}
			normalizedOffset++
		}
		return rawOffset
	}
	fallbackEOL := firstEOL(text)
	if fallbackEOL == "" {
		fallbackEOL = "\n"
	}
	var out strings.Builder
	from, end := 0, 0
	for i := 0; i < count; i++ {
		pos := from + strings.Index(normalized[from:], oldStr)
		start := originalOffset(pos)
		matchEnd := originalOffset(pos + len(oldStr))
		// Mixed files use the matched block's first EOL. Single-line blocks
		// inherit the file's first EOL; files without any EOL default to LF.
		eol := firstEOL(text[start:matchEnd])
		if eol == "" {
			eol = fallbackEOL
		}
		out.WriteString(text[end:start])
		out.WriteString(strings.ReplaceAll(newStr, "\n", eol))
		from, end = pos+len(oldStr), matchEnd
	}
	out.WriteString(text[end:])
	return out.String(), count, nil
}
