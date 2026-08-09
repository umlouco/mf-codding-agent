package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveNormalisesRoot guards the bug where the workspace root and the
// target path were normalised differently — a symlinked root (macOS
// /var -> /private/var) or a Windows 8.3 short name (MARIOF~1) made every
// legitimate path look like an escape attempt.
func TestResolveNormalisesRoot(t *testing.T) {
	raw := t.TempDir()
	resolved, err := filepath.EvalSymlinks(raw)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}

	sub := filepath.Join(resolved, "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(sub, "Cart.php")
	if err := os.WriteFile(target, []byte("<?php\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Root given in its *unresolved* form, exactly as an editor would supply it.
	env := &Env{Root: raw}

	for _, in := range []string{"src/Cart.php", "src\\Cart.php", target} {
		got, err := env.Resolve(in)
		if err != nil {
			t.Fatalf("Resolve(%q) unexpectedly failed: %v", in, err)
		}
		if !strings.EqualFold(got, target) {
			t.Errorf("Resolve(%q) = %q, want %q", in, got, target)
		}
	}
}

func TestResolveAllowsNewFiles(t *testing.T) {
	env := &Env{Root: t.TempDir()}
	got, err := env.Resolve("a/b/c/new.txt")
	if err != nil {
		t.Fatalf("creating a nested new file should be allowed: %v", err)
	}
	if !strings.HasSuffix(filepath.ToSlash(got), "a/b/c/new.txt") {
		t.Errorf("unexpected resolution: %q", got)
	}
}

func TestResolveRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	env := &Env{Root: root}

	cases := []string{
		"../outside.txt",
		"a/../../outside.txt",
		outside,
		filepath.Join(root, "..", "outside.txt"),
	}
	for _, c := range cases {
		if got, err := env.Resolve(c); err == nil {
			t.Errorf("Resolve(%q) should have been rejected, got %q", c, got)
		}
	}
	if _, err := env.Resolve(""); err == nil {
		t.Error("empty path should be rejected")
	}
}

func TestRelIsWorkspaceRelative(t *testing.T) {
	raw := t.TempDir()
	env := &Env{Root: raw}
	abs, err := env.Resolve("pkg/thing.go")
	if err != nil {
		t.Fatal(err)
	}
	if got := env.Rel(abs); got != "pkg/thing.go" {
		t.Errorf("Rel = %q, want pkg/thing.go", got)
	}
}

func TestReplaceIn(t *testing.T) {
	t.Run("unique match", func(t *testing.T) {
		out, n, err := replaceIn("a\nb\nc\n", "b", "B", false)
		if err != nil || n != 1 || out != "a\nB\nc\n" {
			t.Fatalf("got %q, %d, %v", out, n, err)
		}
	})

	t.Run("ambiguous match is refused", func(t *testing.T) {
		_, _, err := replaceIn("x\nx\n", "x", "y", false)
		if err == nil || !strings.Contains(err.Error(), "appears 2 times") {
			t.Fatalf("want an ambiguity error, got %v", err)
		}
	})

	t.Run("replace_all", func(t *testing.T) {
		out, n, err := replaceIn("x\nx\n", "x", "y", true)
		if err != nil || n != 2 || out != "y\ny\n" {
			t.Fatalf("got %q, %d, %v", out, n, err)
		}
	})

	t.Run("CRLF mismatch is explained", func(t *testing.T) {
		_, _, err := replaceIn("a\r\nb\r\n", "a\nb", "z", false)
		if err == nil || !strings.Contains(err.Error(), "CRLF") {
			t.Fatalf("want a CRLF hint, got %v", err)
		}
	})

	t.Run("no-op edit is refused", func(t *testing.T) {
		if _, _, err := replaceIn("a", "a", "a", false); err == nil {
			t.Fatal("identical old/new should be refused")
		}
	})
}

func TestSplitSed(t *testing.T) {
	cases := []struct{ in, pat, repl, flags string }{
		{`s/foo/bar/`, "foo", "bar", ""},
		{`s/foo/bar/g`, "foo", "bar", "g"},
		{`s#a/b#c#g`, "a/b", "c", "g"},
		{`s/a\/b/c/`, `a\/b`, "c", ""},
		{`s/(\d+)/[\1]/g`, `(\d+)`, `[\1]`, "g"},
	}
	for _, c := range cases {
		p, r, f, err := splitSed(c.in)
		if err != nil {
			t.Errorf("splitSed(%q) failed: %v", c.in, err)
			continue
		}
		if p != c.pat || r != c.repl || f != c.flags {
			t.Errorf("splitSed(%q) = (%q,%q,%q), want (%q,%q,%q)", c.in, p, r, f, c.pat, c.repl, c.flags)
		}
	}
	for _, bad := range []string{"", "d/foo/", "s/foo", "s/foo/bar/z"} {
		if _, _, _, err := splitSed(bad); err == nil {
			t.Errorf("splitSed(%q) should have failed", bad)
		}
	}
}

// TestDeniedPatterns covers the only guard left in front of the unix tool,
// which never asks for confirmation.
func TestDeniedPatterns(t *testing.T) {
	for _, bad := range []string{"rm -rf /", "sudo MKFS /dev/sda", "dd if=/dev/zero of=/dev/sda"} {
		if matchDenied(bad) == "" {
			t.Errorf("%q should have matched a destructive pattern", bad)
		}
	}
	for _, ok := range []string{"grep -rn TODO src", "rm -rf build", "go test ./..."} {
		if d := matchDenied(ok); d != "" {
			t.Errorf("%q should be allowed, matched %q", ok, d)
		}
	}
}

// TestSchemasAreValid catches the `"required": null` shape that made strict
// OpenAI-compatible endpoints reject every request.
func TestSchemasAreValid(t *testing.T) {
	r := NewRegistry()
	RegisterFS(r)
	RegisterSearch(r)
	RegisterPosix(r)
	RegisterShell(r)

	list := r.List()
	if len(list) == 0 {
		t.Fatal("no tools registered")
	}
	for _, tool := range list {
		if tool.Schema == nil {
			t.Errorf("%s: nil schema", tool.Name)
			continue
		}
		if tool.Schema["type"] != "object" {
			t.Errorf("%s: schema type = %v, want object", tool.Name, tool.Schema["type"])
		}
		props, ok := tool.Schema["properties"].(map[string]any)
		if !ok || props == nil {
			t.Errorf("%s: properties must be a non-nil object", tool.Name)
		}
		req, ok := tool.Schema["required"].([]string)
		if !ok || req == nil {
			t.Errorf("%s: required must be a non-nil array, got %#v", tool.Name, tool.Schema["required"])
		}
		for _, name := range req {
			if _, found := props[name]; !found {
				t.Errorf("%s: required field %q is not declared in properties", tool.Name, name)
			}
		}
		if tool.Description == "" {
			t.Errorf("%s: missing description", tool.Name)
		}
	}
}

// TestListIsStable guards prompt-cache hit rate: tool definitions render at the
// very front of the request, so a non-deterministic order invalidates the
// cached prefix on every single call.
func TestListIsStable(t *testing.T) {
	r := NewRegistry()
	RegisterFS(r)
	RegisterSearch(r)

	first := r.List()
	for i := 0; i < 20; i++ {
		next := r.List()
		if len(next) != len(first) {
			t.Fatal("length changed between calls")
		}
		for j := range first {
			if first[j].Name != next[j].Name {
				t.Fatalf("tool order is not stable: %s != %s", first[j].Name, next[j].Name)
			}
		}
	}
}
