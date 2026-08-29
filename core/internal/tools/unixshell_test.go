package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestMain pins the Go builtins for the whole package.
//
// These tests assert what the Go implementations produce, down to exact output
// in places. On Linux and macOS the shell prefers the host's own utilities, and
// `nl`, `diff` and `wc` there are formatted differently and differ again between
// GNU and BSD — so without this the suite would be asserting coreutils' output
// on one platform and ours on another. TestPrefersHostUtilities clears the
// variable to cover the delegation itself.
func TestMain(m *testing.M) {
	if err := os.Setenv("MFAGENT_PORTABLE_UTILS", "1"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func writeFile(t *testing.T, root, rel, body string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// run executes a script in root and fails the test on anything that is not a
// plain non-zero exit status.
func run(t *testing.T, root, script string) (string, uint8) {
	t.Helper()
	env := &Env{Root: root}
	out, code, err := runScript(context.Background(), env, env.realRoot(), script)
	if err != nil {
		t.Fatalf("runScript(%q): %v\noutput: %s", script, err, out)
	}
	return out, code
}

func TestShellPipelinesAndOperators(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "a.txt", "alpha\nbeta\ngamma\n")

	// A pipeline mixing an interpreter builtin, a Go builtin and a second
	// Go builtin.
	out, code := run(t, root, `cat a.txt | grep a | wc -l`)
	if code != 0 || !strings.Contains(out, "3") {
		t.Errorf("pipeline: got %q code %d, want 3 lines", out, code)
	}

	// && and || have to see the real exit status of a Go builtin.
	out, code = run(t, root, `grep -q zzz a.txt && echo found || echo missing`)
	if code != 0 || !strings.Contains(out, "missing") {
		t.Errorf("|| branch: got %q code %d, want missing", out, code)
	}

	out, code = run(t, root, `grep -q alpha a.txt && echo found`)
	if code != 0 || !strings.Contains(out, "found") {
		t.Errorf("&& branch: got %q code %d, want found", out, code)
	}

	// grep reports no-match through its status, like the real thing.
	if _, code = run(t, root, `grep -q zzz a.txt`); code != 1 {
		t.Errorf("grep with no match: exit %d, want 1", code)
	}
}

func TestShellLoopsGlobsAndSubstitution(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "one.txt", "1\n")
	writeFile(t, root, "two.txt", "2\n")

	out, code := run(t, root, `for f in *.txt; do echo "found:$f"; done`)
	if code != 0 || !strings.Contains(out, "found:one.txt") || !strings.Contains(out, "found:two.txt") {
		t.Errorf("glob loop: got %q code %d", out, code)
	}

	out, code = run(t, root, `n=$(cat one.txt two.txt | wc -l); echo "count=$n"`)
	if code != 0 || !strings.Contains(out, "count=") || !strings.Contains(out, "2") {
		t.Errorf("command substitution: got %q code %d", out, code)
	}

	out, code = run(t, root, `if grep -q 1 one.txt; then echo yes; else echo no; fi`)
	if code != 0 || !strings.Contains(out, "yes") {
		t.Errorf("if/then: got %q code %d", out, code)
	}
}

// TestShellHonoursCd guards the cwd-aware path resolution: a builtin must
// resolve relative paths against the script's directory, not the workspace root.
func TestShellHonoursCd(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "sub/inner.txt", "deep\n")

	out, code := run(t, root, `cd sub && cat inner.txt`)
	if code != 0 || !strings.Contains(out, "deep") {
		t.Errorf("cd then cat: got %q code %d", out, code)
	}
}

// TestShellConfinesWrites is the security property: the shell is otherwise
// unrestricted, but a redirection still cannot escape the workspace.
func TestShellConfinesWrites(t *testing.T) {
	root := t.TempDir()
	env := &Env{Root: root}

	out, _, err := runScript(context.Background(), env, env.realRoot(), `echo pwned > ../escaped.txt`)
	if err == nil && !strings.Contains(out, "outside the workspace") {
		t.Errorf("a redirection outside the root must fail, got out=%q err=%v", out, err)
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(root), "escaped.txt")); statErr == nil {
		t.Fatal("the script wrote outside the workspace root")
	}

	// Inside the root it works, and the file really lands there.
	if _, code := run(t, root, `echo ok > inside.txt`); code != 0 {
		t.Fatalf("writing inside the root failed with exit %d", code)
	}
	body, err := os.ReadFile(filepath.Join(root, "inside.txt"))
	if err != nil || !strings.Contains(string(body), "ok") {
		t.Errorf("inside.txt = %q, %v", body, err)
	}
}

func TestShellAwk(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "n.txt", "1 one\n2 two\n3 three\n")

	out, code := run(t, root, `awk '{ s += $1 } END { print s }' n.txt`)
	if code != 0 || strings.TrimSpace(out) != "6" {
		t.Errorf("awk sum: got %q code %d, want 6", out, code)
	}

	out, code = run(t, root, `awk -F: '{ print $2 }' <<< 'a:b:c'`)
	if code != 0 || strings.TrimSpace(out) != "b" {
		t.Errorf("awk -F with here-string: got %q code %d, want b", out, code)
	}

	// Output must be LF on every platform, never CRLF.
	out, _ = run(t, root, `awk 'BEGIN { print "x" }'`)
	if strings.Contains(out, "\r") {
		t.Errorf("awk emitted CRLF: %q", out)
	}
}

func TestShellNewUtilities(t *testing.T) {
	root := t.TempDir()

	cases := []struct{ script, want string }{
		{`seq 1 4 | wc -l`, "4"},
		{`echo abc | rev`, "cba"},
		{`basename /a/b/c.txt`, "c.txt"},
		{`basename /a/b/c.txt .txt`, "c"},
		{`dirname /a/b/c.txt`, "/a/b"},
		{`printf 'a\nb\n' | nl`, "1"},
		{`printf 'x.txt\ny.txt\n' | xargs -n 1 basename`, "x.txt"},
	}
	for _, tc := range cases {
		out, code := run(t, root, tc.script)
		if code != 0 || !strings.Contains(out, tc.want) {
			t.Errorf("%s => %q (exit %d), want it to contain %q", tc.script, out, code, tc.want)
		}
	}
}

func TestShellTeeAndDiff(t *testing.T) {
	root := t.TempDir()

	if _, code := run(t, root, `echo hello | tee copy.txt`); code != 0 {
		t.Fatalf("tee exited %d", code)
	}
	body, err := os.ReadFile(filepath.Join(root, "copy.txt"))
	if err != nil || !strings.Contains(string(body), "hello") {
		t.Errorf("tee wrote %q, %v", body, err)
	}

	writeFile(t, root, "x.txt", "a\nb\nc\n")
	writeFile(t, root, "y.txt", "a\nZ\nc\n")

	out, code := run(t, root, `diff -u x.txt y.txt`)
	if code != 1 {
		t.Errorf("diff on differing files: exit %d, want 1", code)
	}
	if !strings.Contains(out, "-b") || !strings.Contains(out, "+Z") || !strings.Contains(out, "@@") {
		t.Errorf("unified diff looks wrong:\n%s", out)
	}

	// Identical files: no output, exit 0.
	out, code = run(t, root, `diff x.txt x.txt`)
	if code != 0 || strings.TrimSpace(strings.TrimPrefix(out, "")) != "" {
		t.Errorf("diff on identical files: got %q exit %d", out, code)
	}
}

func TestShellCommAndPaste(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "l.txt", "a\nb\nd\n")
	writeFile(t, root, "r.txt", "a\nc\nd\n")

	out, code := run(t, root, `comm -1 -2 l.txt r.txt`)
	if code != 0 {
		t.Fatalf("comm exited %d: %s", code, out)
	}
	if !strings.Contains(out, "a") || !strings.Contains(out, "d") || strings.Contains(out, "b") {
		t.Errorf("comm -1 -2 should list only shared lines, got %q", out)
	}

	out, code = run(t, root, `paste -d, l.txt r.txt`)
	if code != 0 || !strings.Contains(out, "a,a") {
		t.Errorf("paste: got %q exit %d", out, code)
	}
}

// TestShellUnknownCommandFallsThrough checks the host-shell path: an unknown
// command must be handed to the host and report its failure as a status rather
// than blowing up the interpreter.
// TestHeadTailAndTr covers three bugs the shell exposed: head used io.EOF as
// an early-stop sentinel and surfaced it as a failure, head and tail ignored
// the bare -N form, and tr treated "a-z" as three literal characters.
func TestHeadTailAndTr(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "five.txt", "1\n2\n3\n4\n5\n")

	out, code := run(t, root, `head -3 five.txt`)
	if code != 0 {
		t.Errorf("head -3 exited %d (stopping at the limit is not a failure): %s", code, out)
	}
	if got := strings.Fields(out); len(got) != 3 {
		t.Errorf("head -3 printed %v, want 3 lines", got)
	}

	if out, code = run(t, root, `head -n 2 five.txt`); code != 0 || len(strings.Fields(out)) != 2 {
		t.Errorf("head -n 2 => %q exit %d, want 2 lines", out, code)
	}

	// Reaching the limit exactly must not error either.
	if out, code = run(t, root, `head -5 five.txt`); code != 0 || len(strings.Fields(out)) != 5 {
		t.Errorf("head -5 => %q exit %d, want 5 lines", out, code)
	}

	if out, code = run(t, root, `tail -2 five.txt`); code != 0 || strings.TrimSpace(out) != "4\n5" {
		t.Errorf("tail -2 => %q exit %d, want 4 and 5", out, code)
	}

	if out, code = run(t, root, `echo abc | tr a-z A-Z`); code != 0 || strings.TrimSpace(out) != "ABC" {
		t.Errorf("tr a-z A-Z => %q exit %d, want ABC", out, code)
	}

	if out, code = run(t, root, `printf 'a1b2\n' | tr -d 0-9`); code != 0 || strings.TrimSpace(out) != "ab" {
		t.Errorf("tr -d 0-9 => %q exit %d, want ab", out, code)
	}

	// head in a pipeline is the case that first showed the bug.
	if out, code = run(t, root, `cat five.txt | head -2 | wc -l`); code != 0 || !strings.Contains(out, "2") {
		t.Errorf("cat | head -2 | wc -l => %q exit %d, want 2", out, code)
	}
}

func TestPasteFromStdin(t *testing.T) {
	root := t.TempDir()
	out, code := run(t, root, `printf 'a\nb\nc\nd\n' | paste -d, - -`)
	if code != 0 {
		t.Fatalf("paste exited %d: %s", code, out)
	}
	if !strings.Contains(out, "a,b") || !strings.Contains(out, "c,d") {
		t.Errorf("paste -d, - - => %q, want a,b and c,d", out)
	}
}

func TestShellUnknownCommandFallsThrough(t *testing.T) {
	root := t.TempDir()
	_, code := run(t, root, `definitely-not-a-real-command-xyz`)
	if code == 0 {
		t.Error("an unknown command should produce a non-zero exit status")
	}
}

func TestShellParseErrorIsReported(t *testing.T) {
	root := t.TempDir()
	env := &Env{Root: root}
	if _, _, err := runScript(context.Background(), env, env.realRoot(), `for f in`); err == nil {
		t.Error("a syntax error should be reported")
	}
}

// TestPrefersHostUtilities covers the choice between a Go builtin and the host's
// own implementation. It runs against whatever this machine actually has, so it
// asserts the decision rather than any particular utility's output.
func TestPrefersHostUtilities(t *testing.T) {
	t.Setenv("MFAGENT_PORTABLE_UTILS", "")

	// Anything that writes is answered in Go on every platform: those resolve
	// through Env.Resolve and report through Env.FileChanged, and delegating
	// them would drop the workspace confinement and the editor notification.
	for _, name := range []string{"mkdir", "touch", "rm", "cp", "mv", "tee"} {
		if hostPreferred[name] {
			t.Errorf("%s writes files and must not be delegated to the host", name)
		}
		if preferHostUtil(name) {
			t.Errorf("preferHostUtil(%q) = true, want false", name)
		}
	}

	if runtime.GOOS == "windows" {
		// Nothing is delegated. The builtins exist precisely because a Windows
		// box has none of these.
		for name := range hostPreferred {
			if preferHostUtil(name) {
				t.Errorf("preferHostUtil(%q) = true on Windows, want false", name)
			}
		}
		return
	}

	// sed is the case that motivated the delegation: a Unix host has a complete
	// one, and the builtin only substitutes.
	if _, err := exec.LookPath("sed"); err != nil {
		t.Skipf("no host sed to defer to: %v", err)
	}
	if !preferHostUtil("sed") {
		t.Fatal("host has sed but preferHostUtil(sed) = false")
	}

	root := t.TempDir()
	writeFile(t, root, "a.txt", "one\ntwo\nthree\n")

	// The address form the builtin rejects outright.
	out, code := run(t, root, `sed -n '2p' a.txt`)
	if code != 0 || strings.TrimSpace(out) != "two" {
		t.Errorf("sed -n '2p': got %q code %d, want two", out, code)
	}

	// The force flag has to win, or there is no way back to the portable
	// behaviour when the host and the builtin disagree.
	t.Setenv("MFAGENT_PORTABLE_UTILS", "1")
	if preferHostUtil("sed") {
		t.Error("MFAGENT_PORTABLE_UTILS did not force the builtin")
	}
	if _, code := run(t, root, `sed -n '2p' a.txt`); code == 0 {
		t.Error("the builtin sed should reject -n, but the script succeeded")
	}
}
