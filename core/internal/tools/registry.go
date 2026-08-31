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
	// Mutating marks a tool that writes, executes or navigates. Nothing asks
	// the user before running one — this is a scheduling fact, not a policy.
	// The agent loop runs mutating calls serially, in the order the model
	// asked for, while read-only calls go in parallel. Two edits to the same
	// file, or a build and the edit it depends on, produce different results
	// depending on which lands first.
	Mutating bool
	// MutatesOn, when set, decides that per invocation instead of per tool.
	// It exists for the shells: `unix` can write, but most scripts only read,
	// and treating the whole tool as mutating would serialise every `grep`
	// behind every build for no reason. See scriptMutates in writeintent.go.
	MutatesOn func(input json.RawMessage) bool
	// Summarize renders a one-line description of a specific invocation, shown
	// in the chat as the call runs. Optional; the tool name is used if absent.
	Summarize func(input json.RawMessage) string
	Run       func(ctx context.Context, env *Env, input json.RawMessage) Result
}

// Mutates reports whether this specific invocation changes state, which is
// what decides whether it runs serially with the other mutating calls in its
// batch or in parallel with the reads.
func (t *Tool) Mutates(input json.RawMessage) bool {
	if t.MutatesOn != nil {
		return t.MutatesOn(input)
	}
	return t.Mutating
}

// Describe renders a one-line account of this invocation for the UI, falling
// back to the tool's name. Every tool call is reported to the user as it runs;
// none of them stops to ask permission first.
func (t *Tool) Describe(input json.RawMessage) string {
	if t.Summarize == nil {
		return t.Name
	}
	if s := t.Summarize(input); s != "" {
		return s
	}
	return t.Name
}

// Env is the ambient context every tool receives.
type Env struct {
	Root string

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

	// EditorTerminal, when set, asks the editor to run a command in a real
	// terminal it owns and report back what happened — see run_shell in
	// shell.go and src/editorTerminal.ts.
	//
	// The command runs in the user's own shell, with their profile, PATH,
	// virtualenv and credential helpers, and stays on screen in a tab they can
	// scroll back through. A command spawned out of this process has none of
	// that: it runs under a bare environment nobody configured, and the only
	// trace it leaves is whatever the model chose to quote back.
	//
	// Nil when the editor has no shell integration to offer, or in any process
	// with no live editor connection (`mfcore sh`, unit tests). run_shell then
	// falls back to spawning the shell itself.
	EditorTerminal func(ctx context.Context, cwd, command string, timeoutMS int) (TerminalRun, error)

	rootOnce sync.Once
	rootReal string
}

// TerminalRun is the outcome of one command run through Env.EditorTerminal.
type TerminalRun struct {
	Output string
	// ExitCode is nil when the terminal could not report one. That is not the
	// same as zero and must not be rendered as success: VS Code only knows the
	// exit status of a command when shell integration is active for that
	// shell, and a command whose result is unknown is a command the model has
	// to verify some other way before believing it worked.
	ExitCode *int
	TimedOut bool
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
