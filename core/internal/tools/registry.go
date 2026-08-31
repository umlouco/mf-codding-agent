package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Result is what a tool hands back to the model. Display is an optional
// shorter form shown in the chat UI when Output is large.
type Result struct {
	Output  string
	Display string
	IsError bool
	// Meta rides along to the UI (e.g. a screenshot path, a diff).
	Meta map[string]any
}

func Ok(s string) Result          { return Result{Output: s} }
func Errf(f string, a ...any) Result {
	return Result{Output: fmt.Sprintf(f, a...), IsError: true}
}

type Tool struct {
	Name        string
	Description string
	Schema      map[string]any
	// Mutating marks a tool that writes, executes or navigates. The agent
	// loop gates every mutating tool through Env.Ask before running it, and
	// runs them serially so the user sees one prompt at a time. Tools do not
	// implement the gate themselves — one central gate cannot be forgotten.
	Mutating bool
	// Summarize renders a one-line description of a specific invocation for
	// the confirmation prompt. Optional; the tool name is used if absent.
	Summarize func(input json.RawMessage) string
	Run       func(ctx context.Context, env *Env, input json.RawMessage) Result
}

// Confirm asks the user to approve this invocation. It returns a ready-made
// error Result when the answer is no, so callers can return it directly.
func (t *Tool) Confirm(ctx context.Context, env *Env, input json.RawMessage) (Result, bool) {
	if !t.Mutating || env == nil || env.Ask == nil {
		return Result{}, true
	}
	summary := t.Name
	if t.Summarize != nil {
		if s := t.Summarize(input); s != "" {
			summary = s
		}
	}
	ok, err := env.Ask(ctx, t.Name, summary, json.RawMessage(input))
	if err != nil {
		return Errf("could not ask for permission to run %s: %v", t.Name, err), false
	}
	if !ok {
		return Errf("The user declined to run %s (%s). Do not retry the same call — "+
			"take a different approach or ask them what they would prefer.", t.Name, summary), false
	}
	return Result{}, true
}

// Env is the ambient context every tool receives.
type Env struct {
	Root string

	// Ask requests user confirmation. Returns true to proceed.
	Ask func(ctx context.Context, tool, summary string, input any) (bool, error)
	// Emit pushes a progress line to the UI.
	Emit func(kind string, payload any)

	// FileChanged notifies the editor that a path was written.
	FileChanged func(path string)

	// EditorWrite, when set, asks the editor to create or fully replace a
	// file's content through its own document/edit APIs instead of a raw OS
	// write — see write_file in fs.go. Nil in any process with no live editor
	// connection (`mfcore sh`, unit tests), which falls back to a plain
	// os.WriteFile.
	EditorWrite func(ctx context.Context, path, content string) error

	// EditorEdit, when set, asks the editor to apply one or more find/replace
	// edits to a file through its own document/edit APIs — see edit_file and
	// multi_edit in fs.go. Nil the same as EditorWrite, and falls back the
	// same way, to an in-process read/replace/write.
	EditorEdit func(ctx context.Context, path string, edits []EditOp) (int, error)

	rootOnce sync.Once
	rootReal string
}

// EditOp is one find/replace instruction handed to Env.EditorEdit — the same
// shape edit_file and multi_edit already take from the model.
type EditOp struct {
	OldString  string
	NewString  string
	ReplaceAll bool
}

// realRoot is the workspace root with symlinks and Windows 8.3 short names
// resolved. Both sides of the containment check must go through the same
// normalisation or they will never compare equal — a root under
// C:\Users\MARIOF~1\… against a target under C:\Users\Mario Flores\… looks
// like an escape attempt when it is the same directory.
func (e *Env) realRoot() string {
	e.rootOnce.Do(func() {
		r, err := filepath.Abs(e.Root)
		if err != nil {
			r = e.Root
		}
		if resolved, err := filepath.EvalSymlinks(r); err == nil {
			r = resolved
		}
		e.rootReal = r
	})
	return e.rootReal
}

// resolveExisting resolves symlinks on the deepest existing ancestor of p and
// re-attaches the non-existent tail, so a path being created is normalised the
// same way as one that already exists.
func resolveExisting(p string) string {
	probe := p
	var tail []string
	for {
		if _, err := os.Lstat(probe); err == nil {
			if resolved, err := filepath.EvalSymlinks(probe); err == nil {
				probe = resolved
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
		tail = append([]string{filepath.Base(probe)}, tail...)
		probe = parent
	}
	return filepath.Join(append([]string{probe}, tail...)...)
}

// Resolve turns a model-supplied path into an absolute path confined to the
// workspace root. Model output is untrusted: reject anything that escapes,
// including via `..` or a symlink pointing out of the tree.
func (e *Env) Resolve(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("path is required")
	}
	root := e.realRoot()

	p = filepath.FromSlash(p)
	if !filepath.IsAbs(p) {
		p = filepath.Join(root, p)
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	abs = resolveExisting(abs)

	// filepath.Rel compares case-insensitively on Windows, which is what we
	// want there and not what we want elsewhere — it already matches the
	// platform's own semantics.
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q is outside the workspace root %s", p, root)
	}
	return abs, nil
}

func (e *Env) Rel(abs string) string {
	if r, err := filepath.Rel(e.realRoot(), resolveExisting(abs)); err == nil {
		return filepath.ToSlash(r)
	}
	return filepath.ToSlash(abs)
}

type Registry struct {
	mu    sync.RWMutex
	tools map[string]*Tool
}

func NewRegistry() *Registry { return &Registry{tools: map[string]*Tool{}} }

func (r *Registry) Add(t *Tool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[t.Name] = t
}

func (r *Registry) Remove(prefix string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name := range r.tools {
		if strings.HasPrefix(name, prefix) {
			delete(r.tools, name)
		}
	}
}

func (r *Registry) Get(name string) (*Tool, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

// List returns tools in a stable order. Tool definitions render at the very
// front of the prompt, so a non-deterministic order would invalidate the
// prompt cache on every request.
func (r *Registry) List() []*Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func obj(props map[string]any, required ...string) map[string]any {
	// A nil variadic marshals to `"required": null`, which strict JSON Schema
	// validators reject — some OpenAI-compatible endpoints refuse the whole
	// request over it. Always emit a real array.
	if required == nil {
		required = []string{}
	}
	if props == nil {
		props = map[string]any{}
	}
	return map[string]any{
		"type":       "object",
		"properties": props,
		"required":   required,
	}
}

func str(desc string) map[string]any  { return map[string]any{"type": "string", "description": desc} }
func num(desc string) map[string]any  { return map[string]any{"type": "integer", "description": desc} }
func boolp(desc string) map[string]any { return map[string]any{"type": "boolean", "description": desc} }
