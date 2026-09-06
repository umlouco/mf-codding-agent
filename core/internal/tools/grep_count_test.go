package tools

import (
	"strings"
	"testing"
)

// Use the same portable shell as unattended workers. TestMain pins builtins
// so a host-installed grep cannot hide a Windows fallback regression.
func TestPortableGrepCountsAndExitStatus(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "one.txt", "alpha\nbeta\nalpha alpha\n")
	writeFile(t, root, "two.txt", "beta\n")
	for _, tc := range []struct {
		command, output string
		code            uint8
	}{
		{`grep -c alpha one.txt`, "2\n", 0},
		{`grep -c absent one.txt`, "0\n", 1},
		{`grep -vc alpha one.txt`, "1\n", 0},
		{`grep -nc alpha one.txt two.txt`, "one.txt:2\ntwo.txt:0\n", 0},
		{`grep -qc alpha one.txt`, "", 0},
		{`n=$(cat one.txt | grep -c alpha); test "$n" = 2 && echo PASS`, "PASS\n", 0},
		{`printf 'a.b\naxb\n' | grep -Fc a.b`, "1\n", 0},
		{`printf 'alpha\nbeta\n' | grep -Ec 'alpha|beta'`, "2\n", 0},
		{`printf 'a|b\nplain\n' | grep -c '|'`, "1\n", 0},
		{`printf 'a+b\naaab\n' | grep -c 'a+b'`, "1\n", 0},
		{`printf 'ab\naab\nb\n' | grep -c '^a\+b$'`, "2\n", 0},
		{`printf '(a)\na\n' | grep -c '(a)'`, "1\n", 0},
	} {
		t.Run(tc.command, func(t *testing.T) {
			out, code := run(t, root, tc.command)
			if out != tc.output || code != tc.code {
				t.Fatalf("output=%q code=%d; want %q code=%d", out, code, tc.output, tc.code)
			}
		})
	}
}

func TestPortableTailStartsAtRequestedLine(t *testing.T) {
	root := t.TempDir()
	for _, flag := range []string{"-n +2", "-n+2"} {
		out, code := run(t, root, `printf 'header\none\ntwo\nthree\nfour\n' | tail `+flag+` | head -n 3`)
		if code != 0 || out != "one\ntwo\nthree\n" {
			t.Fatalf("tail %s: output=%q code=%d", flag, out, code)
		}
	}
}

func TestPortableGrepRejectsUnsupportedFlags(t *testing.T) {
	out, code := run(t, t.TempDir(), `printf 'abc\n' | grep -o a`)
	if code == 0 || !strings.Contains(out, "unsupported grep option") {
		t.Fatalf("unsupported semantics silently accepted: output=%q code=%d", out, code)
	}
}
