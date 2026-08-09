package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// readState guards against the classic agent failure of overwriting a file the
// model has not actually looked at, or that changed underneath it.
type readState struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

var reads = &readState{seen: map[string]time.Time{}}

func (r *readState) mark(path string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if fi, err := os.Stat(path); err == nil {
		r.seen[path] = fi.ModTime()
	}
}

func (r *readState) check(path string) error {
	fi, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil // new file: nothing to clobber
	}
	if err != nil {
		return err
	}
	r.mu.Lock()
	seenAt, ok := r.seen[path]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("refusing to modify %s: read it first", filepath.Base(path))
	}
	if fi.ModTime().After(seenAt) {
		return fmt.Errorf("%s changed on disk since it was read; re-read before editing", filepath.Base(path))
	}
	return nil
}

const maxReadBytes = 2 << 20 // 2 MiB

func looksBinary(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	n := len(b)
	if n > 8000 {
		n = 8000
	}
	head := b[:n]
	if !utf8.Valid(head) {
		return true
	}
	for _, c := range head {
		if c == 0 {
			return true
		}
	}
	return false
}

func numberLines(text string, offset int) string {
	lines := strings.Split(text, "\n")
	var sb strings.Builder
	for i, l := range lines {
		fmt.Fprintf(&sb, "%6d\t%s\n", offset+i+1, l)
	}
	return sb.String()
}

func RegisterFS(r *Registry) {
	r.Add(&Tool{
		Name: "read_file",
		Description: "Read a UTF-8 text file from the workspace. Returns content with 1-based " +
			"line numbers. Use offset/limit for large files. Always read a file before editing it.",
		Schema: obj(map[string]any{
			"path":   str("Workspace-relative path to the file."),
			"offset": num("1-based line to start from. Optional."),
			"limit":  num("Maximum number of lines to return. Optional."),
		}, "path"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Path   string `json:"path"`
				Offset int    `json:"offset"`
				Limit  int    `json:"limit"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			abs, err := env.Resolve(a.Path)
			if err != nil {
				return Errf("%v", err)
			}
			fi, err := os.Stat(abs)
			if err != nil {
				return Errf("cannot read %s: %v", a.Path, err)
			}
			if fi.IsDir() {
				return Errf("%s is a directory; use list_dir or glob", a.Path)
			}
			if fi.Size() > maxReadBytes && a.Limit == 0 {
				return Errf("%s is %d bytes; pass offset/limit to read it in slices", a.Path, fi.Size())
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				return Errf("cannot read %s: %v", a.Path, err)
			}
			if looksBinary(data) {
				return Errf("%s appears to be binary (%d bytes)", a.Path, len(data))
			}
			reads.mark(abs)

			text := strings.ReplaceAll(string(data), "\r\n", "\n")
			if a.Offset > 0 || a.Limit > 0 {
				lines := strings.Split(text, "\n")
				start := 0
				if a.Offset > 0 {
					start = a.Offset - 1
				}
				if start > len(lines) {
					start = len(lines)
				}
				end := len(lines)
				if a.Limit > 0 && start+a.Limit < end {
					end = start + a.Limit
				}
				return Ok(numberLines(strings.Join(lines[start:end], "\n"), start))
			}
			return Ok(numberLines(text, 0))
		},
	})

	r.Add(&Tool{
		Name: "write_file",
		Description: "Create a new file or fully replace an existing one. For partial changes use " +
			"edit_file instead. Overwriting a file you have not read is rejected.",
		Mutating: true,
		Schema: obj(map[string]any{
			"path":    str("Workspace-relative path."),
			"content": str("Full file content."),
		}, "path", "content"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			_ = json.Unmarshal(in, &a)
			return fmt.Sprintf("Write %s (%d lines)", a.Path, strings.Count(a.Content, "\n")+1)
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			abs, err := env.Resolve(a.Path)
			if err != nil {
				return Errf("%v", err)
			}
			if err := reads.check(abs); err != nil {
				return Errf("%v", err)
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return Errf("mkdir: %v", err)
			}
			if err := os.WriteFile(abs, []byte(a.Content), 0o644); err != nil {
				return Errf("write %s: %v", a.Path, err)
			}
			reads.mark(abs)
			if env.FileChanged != nil {
				env.FileChanged(abs)
			}
			n := strings.Count(a.Content, "\n") + 1
			return Ok(fmt.Sprintf("Wrote %s (%d lines, %d bytes).", env.Rel(abs), n, len(a.Content)))
		},
	})

	r.Add(&Tool{
		Name: "edit_file",
		Description: "Replace an exact string in a file. old_string must appear exactly once " +
			"unless replace_all is true. Include surrounding context to disambiguate. " +
			"Preferred over write_file for changes to existing code.",
		Mutating: true,
		Schema: obj(map[string]any{
			"path":        str("Workspace-relative path."),
			"old_string":  str("Exact text to find, including indentation."),
			"new_string":  str("Replacement text."),
			"replace_all": boolp("Replace every occurrence instead of requiring uniqueness."),
		}, "path", "old_string", "new_string"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Path      string `json:"path"`
				OldString string `json:"old_string"`
			}
			_ = json.Unmarshal(in, &a)
			first := strings.TrimSpace(strings.SplitN(a.OldString, "\n", 2)[0])
			if len(first) > 60 {
				first = first[:60] + "…"
			}
			return fmt.Sprintf("Edit %s (replacing %q)", a.Path, first)
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Path       string `json:"path"`
				OldString  string `json:"old_string"`
				NewString  string `json:"new_string"`
				ReplaceAll bool   `json:"replace_all"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			abs, err := env.Resolve(a.Path)
			if err != nil {
				return Errf("%v", err)
			}
			out, n, err := applyEdit(abs, a.OldString, a.NewString, a.ReplaceAll)
			if err != nil {
				return Errf("%v", err)
			}
			if env.FileChanged != nil {
				env.FileChanged(abs)
			}
			_ = out
			return Ok(fmt.Sprintf("Applied %d replacement(s) in %s.", n, env.Rel(abs)))
		},
	})

	r.Add(&Tool{
		Name: "multi_edit",
		Description: "Apply several edit_file operations to one file atomically, in order. " +
			"If any edit fails, none are written.",
		Mutating: true,
		Schema: obj(map[string]any{
			"path": str("Workspace-relative path."),
			"edits": map[string]any{
				"type":        "array",
				"description": "Ordered list of replacements.",
				"items": obj(map[string]any{
					"old_string":  str("Exact text to find."),
					"new_string":  str("Replacement text."),
					"replace_all": boolp("Replace every occurrence."),
				}, "old_string", "new_string"),
			},
		}, "path", "edits"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Path  string           `json:"path"`
				Edits []map[string]any `json:"edits"`
			}
			_ = json.Unmarshal(in, &a)
			return fmt.Sprintf("Apply %d edits to %s", len(a.Edits), a.Path)
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Path  string `json:"path"`
				Edits []struct {
					OldString  string `json:"old_string"`
					NewString  string `json:"new_string"`
					ReplaceAll bool   `json:"replace_all"`
				} `json:"edits"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if len(a.Edits) == 0 {
				return Errf("edits list is empty")
			}
			abs, err := env.Resolve(a.Path)
			if err != nil {
				return Errf("%v", err)
			}
			if err := reads.check(abs); err != nil {
				return Errf("%v", err)
			}
			raw, err := os.ReadFile(abs)
			if err != nil {
				return Errf("read %s: %v", a.Path, err)
			}
			text := string(raw)
			total := 0
			for i, e := range a.Edits {
				next, n, err := replaceIn(text, e.OldString, e.NewString, e.ReplaceAll)
				if err != nil {
					return Errf("edit %d/%d failed: %v (no changes written)", i+1, len(a.Edits), err)
				}
				text = next
				total += n
			}
			if err := os.WriteFile(abs, []byte(text), 0o644); err != nil {
				return Errf("write %s: %v", a.Path, err)
			}
			reads.mark(abs)
			if env.FileChanged != nil {
				env.FileChanged(abs)
			}
			return Ok(fmt.Sprintf("Applied %d edits (%d replacements) to %s.", len(a.Edits), total, env.Rel(abs)))
		},
	})

	r.Add(&Tool{
		Name:        "list_dir",
		Description: "List the entries of a directory (non-recursive).",
		Schema: obj(map[string]any{
			"path": str("Workspace-relative directory. Defaults to the workspace root."),
		}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(in, &a)
			if a.Path == "" {
				a.Path = "."
			}
			abs, err := env.Resolve(a.Path)
			if err != nil {
				return Errf("%v", err)
			}
			entries, err := os.ReadDir(abs)
			if err != nil {
				return Errf("%v", err)
			}
			var sb strings.Builder
			for _, e := range entries {
				if e.IsDir() {
					fmt.Fprintf(&sb, "%s/\n", e.Name())
					continue
				}
				info, _ := e.Info()
				size := int64(0)
				if info != nil {
					size = info.Size()
				}
				fmt.Fprintf(&sb, "%s\t%d\n", e.Name(), size)
			}
			if sb.Len() == 0 {
				return Ok("(empty directory)")
			}
			return Ok(sb.String())
		},
	})
}

func applyEdit(abs, oldStr, newStr string, all bool) (string, int, error) {
	if err := reads.check(abs); err != nil {
		return "", 0, err
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return "", 0, fmt.Errorf("read: %w", err)
	}
	text, n, err := replaceIn(string(raw), oldStr, newStr, all)
	if err != nil {
		return "", 0, err
	}
	if err := os.WriteFile(abs, []byte(text), 0o644); err != nil {
		return "", 0, fmt.Errorf("write: %w", err)
	}
	reads.mark(abs)
	return text, n, nil
}

func replaceIn(text, oldStr, newStr string, all bool) (string, int, error) {
	if oldStr == "" {
		return "", 0, fmt.Errorf("old_string must not be empty")
	}
	if oldStr == newStr {
		return "", 0, fmt.Errorf("old_string and new_string are identical")
	}
	count := strings.Count(text, oldStr)
	if count == 0 {
		// A CRLF file with an LF-normalised search string is the usual culprit.
		if strings.Contains(text, "\r\n") && strings.Count(strings.ReplaceAll(text, "\r\n", "\n"), oldStr) > 0 {
			return "", 0, fmt.Errorf("old_string not found (file uses CRLF line endings; match them or re-read the file)")
		}
		return "", 0, fmt.Errorf("old_string not found")
	}
	if count > 1 && !all {
		return "", 0, fmt.Errorf("old_string appears %d times; add surrounding context or set replace_all", count)
	}
	if all {
		return strings.ReplaceAll(text, oldStr, newStr), count, nil
	}
	return strings.Replace(text, oldStr, newStr, 1), 1, nil
}
