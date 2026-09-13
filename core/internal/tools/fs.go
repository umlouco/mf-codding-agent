package tools

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

// readState guards against the classic agent failure of overwriting a file the
// model has not actually looked at, or that changed underneath it.
//
// The identity it compares is the file's content, not its timestamp. An earlier
// version stored mtime and refused any write whose mtime was newer, which
// rejected edits the native editor would have applied correctly: another
// worker saving identical bytes, a formatter no-op, an editor touching the file
// on focus, or a filesystem with coarse mtime resolution all read as "changed"
// even though the text the model saw was still current. A content hash says
// what the check actually means — the text moved on — and says it the same on
// Windows, Linux and macOS.
type readState struct {
	mu   sync.Mutex
	seen map[string][32]byte
}

var reads = &readState{seen: map[string][32]byte{}}

func (r *readState) mark(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	r.mu.Lock()
	r.seen[path] = sha256.Sum256(data)
	r.mu.Unlock()
}

// check reports whether path is safe to modify. display is the same file as
// the model refers to it — a workspace-relative path it can paste straight
// back into the next call.
//
// Both refusals name that next call on purpose. A refusal that states a policy
// without stating the remedy is one the model has to invent a way around, and
// the way it invents is the shell: it writes the bytes through `tee`, the write
// succeeds, and it concludes the file tools were the broken ones. Saying "call
// read_file, then retry" ends that in one round.
func (r *readState) check(path, display string) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil // new file: nothing to clobber
	}
	if err != nil {
		return err
	}
	r.mu.Lock()
	seen, ok := r.seen[path]
	r.mu.Unlock()
	if !ok {
		return fmt.Errorf("refusing to modify %s without reading it first: "+
			"call read_file with path %q, then retry this edit. "+
			"The unix and run_shell tools reach these same files through the same "+
			"workspace root, so writing the change through a shell instead is not a "+
			"way around this check", display, display)
	}
	if sha256.Sum256(data) != seen {
		return fmt.Errorf("%s changed since it was last read: "+
			"call read_file with path %q again and rebase the edit on what is there now",
			display, display)
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
		// The sampling boundary may fall inside a valid multibyte character.
		// Do not classify ordinary UTF-8 source as binary because we cut it.
		for n > 0 && !utf8.RuneStart(b[n]) {
			n--
		}
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
		Description: "Read a UTF-8 text file from the workspace. Each line is returned as " +
			"`<line-number>\\t<text>`; the number and the tab after it are a display gutter, " +
			"not file content. Call this immediately before editing, and copy old_string from " +
			"the current output without the line-number gutter. Use offset/limit for large files.",
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
			// Every refusal below names the call that gets past it. They are
			// the ones a model otherwise routes around with `cat`, and then
			// reasons backwards from to conclude the shell can see files this
			// tool cannot — so each says what to do next, and the ones that
			// are a fact about the file rather than a limit of this tool say
			// that too. See readState.check.
			fi, err := os.Stat(abs)
			if err != nil {
				if os.IsNotExist(err) {
					return Errf("%s does not exist. Use glob to find where it actually is "+
						"(pattern %q), or list_dir on the directory you expected it in",
						a.Path, "**/"+filepath.Base(a.Path))
				}
				return Errf("cannot read %s: %v", a.Path, err)
			}
			if fi.IsDir() {
				return Errf("%s is a directory; use list_dir or glob", a.Path)
			}
			if fi.Size() > maxReadBytes && a.Limit == 0 {
				return Errf("%s is %d bytes, over the %d-byte limit for reading a whole file at once. "+
					"Page through it by passing offset and limit (start with offset 1, limit 500), "+
					"or use grep to jump straight to the part you need",
					a.Path, fi.Size(), maxReadBytes)
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				return Errf("cannot read %s: %v", a.Path, err)
			}
			if looksBinary(data) {
				return Errf("%s is binary (%d bytes), so there is no text to return. "+
					"That is a property of the file, not a limit of this tool — reading it "+
					"through a shell will not produce text either",
					a.Path, len(data))
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
		Description: "Create a new file, or replace an existing file's entire content. An existing " +
			"path must have been read first: this replaces everything, so an unread file is refused " +
			"rather than clobbered. For any change to existing code prefer edit_file or multi_edit, " +
			"which replace only the exact text you name and stay reviewable. `content` becomes the " +
			"whole file, so it must not include read_file's line-number gutter.",
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
			if err := reads.check(abs, env.Rel(abs)); err != nil {
				return Errf("%v", err)
			}
			if env.EditorWrite != nil {
				// Goes through the editor's own document/edit APIs — if the file
				// is open, this lands as a real edit against whatever is actually
				// in the buffer (including unsaved changes) instead of a raw byte
				// overwrite that would clobber them. See src/editorFs.ts.
				if err := env.EditorWrite(ctx, abs, a.Content); err != nil {
					return Errf("write %s: %v", a.Path, err)
				}
			} else {
				if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
					return Errf("mkdir: %v", err)
				}
				if err := os.WriteFile(abs, []byte(a.Content), 0o644); err != nil {
					return Errf("write %s: %v", a.Path, err)
				}
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
		Description: "Replace exact text in an existing file. Read the file first and copy " +
			"`old_string` verbatim from what is there now — exact indentation, no read_file " +
			"line-number gutter. `old_string` must occur exactly once unless `replace_all` is " +
			"true; include enough surrounding lines to make it unique. CRLF and LF are equivalent, " +
			"and replacements preserve the file's line-ending style. If it returns 'old_string " +
			"not found', re-read the file and copy the current block again; do not repeat the " +
			"same string. Preferred over write_file for changes to existing code.",
		Mutating: true,
		Schema: obj(map[string]any{
			"path":        str("Workspace-relative path."),
			"old_string":  str("Exact current text to replace, copied from read_file output with the line-number gutter removed. Include surrounding lines so it is unique."),
			"new_string":  str("Replacement text. May be empty to delete the matched block."),
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
			// No stale-read gate here. A find/replace edit names the exact
			// current text, so the match itself is the safety check — and when
			// an editor is connected the match is computed against the live
			// document (see Env.EditorEdit). Refusing on file mtime instead
			// rejected edits the native editor would have applied correctly,
			// for example when another worker had touched the file since this
			// one read it. A file that truly moved on simply no longer contains
			// old_string, and the error says to re-read.
			var n int
			if env.EditorEdit != nil {
				// The match itself is recomputed in the editor against whatever
				// text is actually live there — see the comment on write_file
				// above and src/editorFs.ts — and lands as a small range edit,
				// not a full-file rewrite, which is what makes this safe to use
				// on a large file.
				n, err = env.EditorEdit(ctx, abs, []EditOp{
					{OldString: a.OldString, NewString: a.NewString, ReplaceAll: a.ReplaceAll},
				})
			} else {
				_, n, err = applyEditRaw(abs, a.OldString, a.NewString, a.ReplaceAll)
			}
			if err != nil {
				return Errf("%v", err)
			}
			reads.mark(abs)
			if env.FileChanged != nil {
				env.FileChanged(abs)
			}
			return Ok(fmt.Sprintf("Applied %d replacement(s) in %s.", n, env.Rel(abs)))
		},
	})

	r.Add(&Tool{
		Name: "multi_edit",
		Description: "Apply several edit_file operations to one file in the order given, atomically. " +
			"Each edit sees the result of the one before it; if any edit fails, nothing is written. " +
			"Use it for multiple non-contiguous changes to the same file instead of several edit_file " +
			"calls. Same old_string rules as edit_file: copied verbatim from a fresh read, no " +
			"line-number gutter, unique unless replace_all.",
		Mutating: true,
		Schema: obj(map[string]any{
			"path": str("Workspace-relative path."),
			"edits": map[string]any{
				"type":        "array",
				"description": "Ordered list of replacements.",
				"items": obj(map[string]any{
					"old_string":  str("Exact current text to find (no line-number gutter)."),
					"new_string":  str("Replacement text; empty deletes the block."),
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
			// Same as edit_file: exact-match replacement is its own safety check,
			// and the gate is skipped so the native editor's live-buffer match
			// decides. See the note in edit_file.
			var total int
			if env.EditorEdit != nil {
				// The whole ordered batch goes over in one call so the editor can
				// apply it as a single native edit — one undo step — rather than
				// one write per replacement. See src/editorFs.ts, which folds the
				// edits the same way this function does below (each one sees the
				// text the one before it produced).
				ops := make([]EditOp, len(a.Edits))
				for i, e := range a.Edits {
					ops[i] = EditOp{OldString: e.OldString, NewString: e.NewString, ReplaceAll: e.ReplaceAll}
				}
				var err error
				total, err = env.EditorEdit(ctx, abs, ops)
				if err != nil {
					return Errf("%v (no changes written)", err)
				}
			} else {
				raw, err := os.ReadFile(abs)
				if err != nil {
					return Errf("read %s: %v", a.Path, err)
				}
				text := string(raw)
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

// applyEditRaw is the fallback used when no editor is connected to apply the
// edit natively (see Env.EditorEdit) — a plain in-process read/replace/write.
// It reads the file here, so the exact-match rules in replaceIn are the only
// gate; edit_file no longer requires a prior read_file.
func applyEditRaw(abs, oldStr, newStr string, all bool) (string, int, error) {
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
