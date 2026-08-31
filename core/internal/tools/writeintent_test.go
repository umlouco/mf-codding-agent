package tools

import (
	"encoding/json"
	"testing"
)

// The read-only cases matter as much as the writing ones. A classifier that
// gates everything is trivially safe and useless — it puts a prompt in front of
// `grep | wc -l`, which is what the ungated shell was there to avoid.
func TestScriptMutatesReadOnly(t *testing.T) {
	for _, script := range []string{
		`grep -rn TODO src | wc -l`,
		`cat go.mod`,
		`ls -l && cat README.md | head -20`,
		`find . -name '*.go' -type f | sort | uniq`,
		`for f in *.go; do wc -l "$f"; done`,
		`diff -u a.txt b.txt`,
		`if grep -q package main main.go; then echo yes; fi`,
		`cat log.txt 2>&1 | tail -5`,
		`echo "$(cat VERSION)"`,
		`sed 's/foo/bar/' input.txt`,
		`grep -rl TODO . | xargs wc -l`,
		`awk -F, '{print $2}' data.csv | sort -u`,
		`cat < input.txt`,
		`FOO=bar; echo done`,
	} {
		if mutates, reason := scriptMutates(script); mutates {
			t.Errorf("scriptMutates(%q) = true (%s), want false", script, reason)
		}
	}
}

func TestScriptMutatesWrites(t *testing.T) {
	for _, tc := range []struct {
		script string
		why    string
	}{
		{`echo hi > out.txt`, "plain redirection"},
		{`echo hi >> out.txt`, "appending redirection"},
		{`cat a b &> merged.txt`, "all-streams redirection"},
		{`rm -rf build`, "a deleting builtin"},
		{`mkdir -p .mfagent/scratch`, "a creating builtin"},
		{`cp src.go dst.go`, "a copying builtin"},
		{`mv old.go new.go`, "a renaming builtin"},
		{`cat tpl | tee out.txt`, "tee"},
		{`go build ./...`, "a host program"},
		{`python script.py`, "a host program"},
		{`git commit -m x`, "a host program"},
		{`sed -i 's/a/b/' f.txt`, "in-place sed"},
		{`sed -i.bak 's/a/b/' f.txt`, "in-place sed with a suffix"},
		{`find . -name '*.tmp' -delete`, "find -delete"},
		{`find . -name '*.go' -exec rm {} ;`, "find -exec"},
		{`grep -rl TODO . | xargs rm`, "a writing command under xargs"},
		{`ls | xargs -n1 python`, "a host program under xargs"},
		{`$CMD --flag`, "a runtime-built command name"},
		{`eval "rm -rf $dir"`, "eval can run anything"},
		{`source ./setup.sh`, "source runs another script"},
		{`. ./setup.sh`, "dot-source runs another script"},
		{`command rm f`, "command bypasses the builtin lookup"},
		{`exec >out.txt`, "exec redirects the shell's own output"},
		{`grep -q x f && rm f`, "a write on the right of &&"},
		{`echo "$(rm -rf tmp)"`, "a write inside command substitution"},
		{`for f in *.txt; do rm "$f"; done`, "a write inside a loop body"},
		{`python <<'EOF'
print("hi")
EOF`, "a heredoc fed to a host program"},
		{`cat <<'EOF' > gen.py
print("hi")
EOF`, "a heredoc redirected to a file"},
	} {
		mutates, reason := scriptMutates(tc.script)
		if !mutates {
			t.Errorf("scriptMutates(%q) = false, want true (%s)", tc.script, tc.why)
			continue
		}
		if reason == "" {
			t.Errorf("scriptMutates(%q) reported no reason", tc.script)
		}
	}
}

// An unparseable script must never be classified as read-only: runScript
// rejects it anyway, and agreeing that it is harmless is how a parser
// disagreement turns into an ungated write.
func TestScriptMutatesUnparseable(t *testing.T) {
	if mutates, _ := scriptMutates(`if [ -f x ]; then`); !mutates {
		t.Error("an unparseable script must be treated as mutating")
	}
}

func TestUnixMutatesOn(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  bool
	}{
		{`{"command":"wc -l *.go"}`, false},
		{`{"command":"rm -rf out"}`, true},
		{`not json at all`, true},
		// An empty script has nothing to classify. Run rejects it outright
		// before reaching the shell, so gating it would only add a prompt in
		// front of an error.
		{`{}`, false},
	} {
		if got := unixMutatesOn(json.RawMessage(tc.input)); got != tc.want {
			t.Errorf("unixMutatesOn(%s) = %v, want %v", tc.input, got, tc.want)
		}
	}
}

// The confirmation prompt has to say why it is asking. A summary that only
// echoes the script makes every prompt look the same, which is how users learn
// to approve without reading.
func TestSummarizeUnixLeadsWithReason(t *testing.T) {
	got := summarizeUnix(json.RawMessage(`{"command":"rm -rf build"}`))
	if want := "runs rm  —  rm -rf build"; got != want {
		t.Errorf("summarizeUnix = %q, want %q", got, want)
	}
	multi := summarizeUnix(json.RawMessage("{\"command\":\"go build ./...\\ngo test ./...\"}"))
	if want := "runs go on the host  —  go build ./... …"; multi != want {
		t.Errorf("summarizeUnix multiline = %q, want %q", multi, want)
	}
}

// Tools.Mutates is what both the permission gate and the serial-ordering split
// consult, so a per-call classifier has to reach both.
func TestToolMutatesPerCall(t *testing.T) {
	r := NewRegistry()
	RegisterPosix(r)
	tool, ok := r.Get("unix")
	if !ok {
		t.Fatal("unix tool not registered")
	}
	if tool.Mutates(json.RawMessage(`{"command":"grep -rn TODO ."}`)) {
		t.Error("a read-only script must not be gated")
	}
	if !tool.Mutates(json.RawMessage(`{"command":"tee out.txt"}`)) {
		t.Error("a writing script must be gated")
	}
}
