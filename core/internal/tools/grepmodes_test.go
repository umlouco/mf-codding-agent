package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// grepCall runs the grep tool against root. Arguments go through json.Marshal
// rather than a hand-written string: the patterns here are full of backslashes,
// and escaping them twice by hand tests the test, not the tool.
func grepCall(t *testing.T, root string, args map[string]any) Result {
	t.Helper()
	r := NewRegistry()
	RegisterSearch(r)
	tool, ok := r.Get("grep")
	if !ok {
		t.Fatal("grep not registered")
	}
	in, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return tool.Run(context.Background(), &Env{Root: root}, in)
}

func grepIn(t *testing.T, root string, args map[string]any) string {
	t.Helper()
	res := grepCall(t, root, args)
	if res.IsError {
		t.Fatalf("grep(%v) errored: %s", args, res.Output)
	}
	return res.Output
}

func grepErr(t *testing.T, root string, args map[string]any) string {
	t.Helper()
	res := grepCall(t, root, args)
	if !res.IsError {
		t.Fatalf("grep(%v) unexpectedly succeeded: %s", args, res.Output)
	}
	return res.Output
}

// A Delphi .dpr uses clause is the exact shape that sent the model into a shell
// pipeline and four disagreeing counts. It is here because it exercises all
// three things at once: extraction, more than one match on a line, and a total
// that has to be right.
const dprSource = `program SAC;

uses
  Vcl.Forms,
  GS.SAC.Main in 'src\merge-package\core\GS.SAC.Main.pas',
  GS.SAC.Utils in 'src\merge-package\core\GS.SAC.Utils.pas',
  GS.SAC.Dialog in 'src\merge-package\ui\GS.SAC.Dialog.pas',
  GS.SAC.Utils in 'src\merge-package\core\GS.SAC.Utils.pas',
  GS.Shared.Ini in 'shared\GenericUtils\GS.Shared.Ini.pas';

begin
end.
`

// Two units declared on a single line. Taking only the first match per line is
// how an extracted list quietly comes up short, which is the failure that
// produced "182 in the task, 170 from my grep".
const dprCrowded = `uses
  A.One in 'src\merge-package\a\A.One.pas', A.Two in 'src\merge-package\a\A.Two.pas';
`

// In a Go raw string `\\` is two characters, which the regexp engine reads as
// an escaped backslash and matches the single one a Windows path contains.
const usesPattern = `(\w[\w.]*) in '(src\\merge-package\\[^']*)'`

func TestGrepCaptureExtractsEveryMatchOnALine(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "SAC.dpr", dprSource)
	writeFile(t, root, "Other.dpr", dprCrowded)

	out := grepIn(t, root, map[string]any{"pattern": usesPattern, "capture": 1, "unique": true, "limit": 100})
	for _, want := range []string{"A.One", "A.Two", "GS.SAC.Main", "GS.SAC.Utils", "GS.SAC.Dialog"} {
		if !strings.Contains(out, want) {
			t.Errorf("unique capture output is missing %q:\n%s", want, out)
		}
	}
	// GS.Shared.Ini is not under src\merge-package and must not be extracted.
	if strings.Contains(out, "GS.Shared.Ini") {
		t.Errorf("extracted a unit outside the filtered path:\n%s", out)
	}
	// Declared twice in SAC.dpr, so unique has to collapse it to one line.
	if n := strings.Count(out, "GS.SAC.Utils"); n != 1 {
		t.Errorf("GS.SAC.Utils appears %d times under unique, want 1:\n%s", n, out)
	}
}

// The whole point of count mode: one authoritative number, and the raw and
// distinct totals reported side by side rather than derived from two pipelines.
func TestGrepCountReportsTotalAndDistinct(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "SAC.dpr", dprSource)

	out := grepIn(t, root, map[string]any{"pattern": usesPattern, "capture": 1, "output_mode": "count", "unique": true})
	if !strings.Contains(out, "total: 4 matches") {
		t.Errorf("want a raw total of 4 matches:\n%s", out)
	}
	if !strings.Contains(out, "distinct: 3") {
		t.Errorf("want 3 distinct units:\n%s", out)
	}
	if !strings.Contains(out, "SAC.dpr:4") {
		t.Errorf("want the per-file count:\n%s", out)
	}
}

// count mode must ignore limit. A total that silently stops at the limit is
// worse than no total, because it looks like an answer.
func TestGrepCountIgnoresLimit(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "SAC.dpr", dprSource)

	out := grepIn(t, root, map[string]any{"pattern": usesPattern, "capture": 1, "output_mode": "count", "limit": 2})
	if !strings.Contains(out, "total: 4 matches") {
		t.Errorf("count mode honoured limit and reported a short total:\n%s", out)
	}
}

// Without capture a hit is a line; with capture it is a match. Both counts are
// correct and they differ, so the output has to say which one it measured.
func TestGrepCountNamesWhatItCounted(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "Other.dpr", dprCrowded)

	lines := grepIn(t, root, map[string]any{"pattern": usesPattern, "output_mode": "count"})
	if !strings.Contains(lines, "total: 1 matching lines") {
		t.Errorf("without capture, hits are lines:\n%s", lines)
	}
	matches := grepIn(t, root, map[string]any{"pattern": usesPattern, "capture": 1, "output_mode": "count"})
	if !strings.Contains(matches, "total: 2 matches") {
		t.Errorf("with capture, hits are matches:\n%s", matches)
	}
}

func TestGrepFilesMode(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "SAC.dpr", dprSource)
	writeFile(t, root, "Other.dpr", dprCrowded)

	out := grepIn(t, root, map[string]any{"pattern": "merge-package", "output_mode": "files"})
	if !strings.Contains(out, "SAC.dpr") || !strings.Contains(out, "Other.dpr") {
		t.Errorf("files mode did not list both files:\n%s", out)
	}
	if strings.Contains(out, ":") {
		t.Errorf("files mode must emit bare paths:\n%s", out)
	}
	// The deprecated alias has to keep working.
	if alias := grepIn(t, root, map[string]any{"pattern": "merge-package", "files_only": true}); alias != out {
		t.Errorf("files_only disagreed with output_mode files:\n%q\n%q", alias, out)
	}
}

// A capture group that does not exist is the kind of dead end that costs a
// round to discover, so the refusal says how many groups there actually are.
func TestGrepRejectsMissingCaptureGroup(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "SAC.dpr", dprSource)

	msg := grepErr(t, root, map[string]any{"pattern": "uses", "capture": 3})
	if !strings.Contains(msg, "has 0 parenthesised group") {
		t.Errorf("refusal should report the real group count: %s", msg)
	}
	if bad := grepErr(t, root, map[string]any{"pattern": "uses", "output_mode": "tally"}); !strings.Contains(bad, `"count"`) {
		t.Errorf("refusal should list the valid modes: %s", bad)
	}
}

// Truncated content output has to point at the mode that answers the question
// it just failed to answer, or the next step is a shell pipeline.
func TestGrepTruncationPointsAtCountMode(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "SAC.dpr", dprSource)

	out := grepIn(t, root, map[string]any{"pattern": usesPattern, "limit": 1})
	if !strings.Contains(out, `output_mode "count"`) {
		t.Errorf("truncation note should point at count mode:\n%s", out)
	}
}
