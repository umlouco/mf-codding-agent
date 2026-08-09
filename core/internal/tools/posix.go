package tools

// A POSIX toolbox implemented natively in Go.
//
// The point is portability: these commands behave identically on Windows,
// macOS and Linux with no busybox, no WSL and no Git-Bash dependency. They are
// the utilities the shell in unixshell.go dispatches to; shell syntax itself
// lives there, and anything without an implementation here falls through to
// the host shell.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// execFunc re-enters the shell's command dispatch. Utilities that run other
// commands — xargs — use it so the commands they spawn resolve exactly as they
// would at the top level.
type execFunc func(ctx context.Context, args []string) error

type cmdCtx struct {
	ctx  context.Context
	env  *Env
	dir  string
	args []string
	in   io.Reader
	out  io.Writer
	errw io.Writer
	exec execFunc
}

// resolve interprets a relative path against the script's current directory,
// so cd behaves as a shell user expects, and then confines the result to the
// workspace root.
func (c *cmdCtx) resolve(p string) (string, error) {
	if p != "" && !filepath.IsAbs(p) && c.dir != "" {
		p = filepath.Join(c.dir, p)
	}
	return c.env.Resolve(p)
}

type builtin struct {
	fn    func(c *cmdCtx) error
	usage string
}

var builtins map[string]builtin

func init() {
	// echo, pwd, cd, test, printf and read are deliberately absent: the shell
	// interpreter handles those itself and never dispatches them here.
	builtins = map[string]builtin{
		"ls":       {fn: cmdLs, usage: "ls [-l] [-a] [-R] [path...]"},
		"cat":      {fn: cmdCat, usage: "cat [-n] [file...]"},
		"head":     {fn: cmdHead, usage: "head [-n N | -N] [file...]"},
		"tail":     {fn: cmdTail, usage: "tail [-n N | -N] [file...]"},
		"wc":       {fn: cmdWc, usage: "wc [-l] [-w] [-c] [file...]"},
		"grep":     {fn: cmdGrep, usage: "grep [-i] [-v] [-n] [-r] [-q] PATTERN [file...]"},
		"sed":      {fn: cmdSed, usage: "sed s/re/replacement/[g] [file...]"},
		"awk":      {fn: cmdAwk, usage: "awk [-F sep] [-v var=val] PROGRAM [file...]"},
		"sort":     {fn: cmdSort, usage: "sort [-r] [-u] [-n] [file...]"},
		"uniq":     {fn: cmdUniq, usage: "uniq [-c] [file...]"},
		"cut":      {fn: cmdCut, usage: "cut -d DELIM -f N[,N...] [file...]"},
		"tr":       {fn: cmdTr, usage: "tr [-d] SET1 [SET2]"},
		"find":     {fn: cmdFind, usage: "find [path] [-name GLOB] [-type f|d]"},
		"stat":     {fn: cmdStat, usage: "stat file..."},
		"du":       {fn: cmdDu, usage: "du [path]"},
		"which":    {fn: cmdWhich, usage: "which name..."},
		"xargs":    {fn: cmdXargs, usage: "xargs [-n N] [-I REPL] command [arg...]"},
		"tee":      {fn: cmdTee, usage: "tee [-a] file..."},
		"diff":     {fn: cmdDiff, usage: "diff [-u] old new"},
		"basename": {fn: cmdBasename, usage: "basename path [suffix]"},
		"dirname":  {fn: cmdDirname, usage: "dirname path..."},
		"seq":      {fn: cmdSeq, usage: "seq [first [incr]] last"},
		"rev":      {fn: cmdRev, usage: "rev [file...]"},
		"nl":       {fn: cmdNl, usage: "nl [file...]"},
		"comm":     {fn: cmdComm, usage: "comm [-1] [-2] [-3] file1 file2"},
		"paste":    {fn: cmdPaste, usage: "paste [-d DELIM] file..."},
		"mkdir":    {fn: cmdMkdir, usage: "mkdir [-p] dir..."},
		"touch":    {fn: cmdTouch, usage: "touch file..."},
		"rm":       {fn: cmdRm, usage: "rm [-r] [-f] path..."},
		"cp":       {fn: cmdCp, usage: "cp [-r] src dst"},
		"mv":       {fn: cmdMv, usage: "mv src dst"},
	}
}

func clamp(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + fmt.Sprintf("\n… (truncated, %d bytes total)", len(s))
}

// ---- flag helpers ------------------------------------------------------

type flags struct {
	set  map[byte]bool
	vals map[byte]string
	rest []string
}

// parseFlags consumes leading -abc style flags. Letters listed in withValue
// take the following token (or the remainder of the cluster) as their value.
func parseFlags(args []string, withValue string) (*flags, error) {
	f := &flags{set: map[byte]bool{}, vals: map[byte]string{}}
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			i++
			break
		}
		if len(a) < 2 || a[0] != '-' {
			break
		}
		body := a[1:]
		for j := 0; j < len(body); j++ {
			ch := body[j]
			if strings.IndexByte(withValue, ch) >= 0 {
				if j+1 < len(body) {
					f.vals[ch] = body[j+1:]
				} else if i+1 < len(args) {
					i++
					f.vals[ch] = args[i]
				} else {
					return nil, fmt.Errorf("-%c requires a value", ch)
				}
				f.set[ch] = true
				j = len(body)
				break
			}
			f.set[ch] = true
		}
	}
	f.rest = args[i:]
	return f, nil
}

// eachInput feeds either the named files or stdin to fn.
func eachInput(c *cmdCtx, files []string, fn func(name string, r io.Reader) error) error {
	if len(files) == 0 {
		return fn("", c.in)
	}
	for _, name := range files {
		abs, err := c.resolve(name)
		if err != nil {
			return err
		}
		f, err := os.Open(abs)
		if err != nil {
			return err
		}
		err = fn(name, f)
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// errStopScan ends a scan early without it counting as a failure. head
// reaching its limit is a normal stop, not an error to report.
var errStopScan = errors.New("stop scanning")

func scanLines(r io.Reader, fn func(line string) error) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		if err := fn(sc.Text()); err != nil {
			if errors.Is(err, errStopScan) {
				return nil
			}
			return err
		}
	}
	return sc.Err()
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// lineCountFlag reads the line count head and tail accept, in both the -n N
// and the bare -N form, and returns whatever arguments are left.
func lineCountFlag(args []string, def int) (int, []string, error) {
	n := def
	var rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-n" && i+1 < len(args):
			v, err := strconv.Atoi(args[i+1])
			if err != nil {
				return 0, nil, fmt.Errorf("invalid -n value %q", args[i+1])
			}
			n = v
			i++
		case strings.HasPrefix(a, "-n") && len(a) > 2:
			v, err := strconv.Atoi(a[2:])
			if err != nil {
				return 0, nil, fmt.Errorf("invalid -n value %q", a[2:])
			}
			n = v
		case len(a) > 1 && a[0] == '-' && isAllDigits(a[1:]):
			n, _ = strconv.Atoi(a[1:])
		default:
			rest = append(rest, a)
		}
	}
	return n, rest, nil
}

// ---- commands ----------------------------------------------------------

func cmdLs(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	paths := f.rest
	if len(paths) == 0 {
		paths = []string{"."}
	}
	for _, p := range paths {
		abs, err := c.resolve(p)
		if err != nil {
			return err
		}
		if f.set['R'] {
			err = walkFiles(abs, func(a string, d fs.DirEntry) error {
				fmt.Fprintln(c.out, c.env.Rel(a))
				return nil
			})
			if err != nil {
				return err
			}
			continue
		}
		fi, err := os.Stat(abs)
		if err != nil {
			return err
		}
		if !fi.IsDir() {
			fmt.Fprintln(c.out, p)
			continue
		}
		entries, err := os.ReadDir(abs)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if !f.set['a'] && strings.HasPrefix(e.Name(), ".") {
				continue
			}
			if f.set['l'] {
				info, err := e.Info()
				if err != nil {
					continue
				}
				kind := "-"
				if e.IsDir() {
					kind = "d"
				}
				fmt.Fprintf(c.out, "%s %10d %s %s\n", kind, info.Size(),
					info.ModTime().Format("2006-01-02 15:04"), e.Name())
			} else if e.IsDir() {
				fmt.Fprintln(c.out, e.Name()+"/")
			} else {
				fmt.Fprintln(c.out, e.Name())
			}
		}
	}
	return nil
}

func cmdCat(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	n := 0
	return eachInput(c, f.rest, func(_ string, r io.Reader) error {
		return scanLines(r, func(line string) error {
			n++
			if f.set['n'] {
				fmt.Fprintf(c.out, "%6d\t%s\n", n, line)
			} else {
				fmt.Fprintln(c.out, line)
			}
			return nil
		})
	})
}

func cmdHead(c *cmdCtx) error {
	limit, rest, err := lineCountFlag(c.args, 10)
	if err != nil {
		return err
	}
	// The count runs across every input, so `head -3 a b` stops at three lines
	// overall rather than three per file.
	count := 0
	return eachInput(c, rest, func(_ string, r io.Reader) error {
		if count >= limit {
			return nil
		}
		return scanLines(r, func(line string) error {
			if count >= limit {
				return errStopScan
			}
			count++
			fmt.Fprintln(c.out, line)
			return nil
		})
	})
}

func cmdTail(c *cmdCtx) error {
	limit, rest, err := lineCountFlag(c.args, 10)
	if err != nil {
		return err
	}
	return eachInput(c, rest, func(_ string, r io.Reader) error {
		ring := make([]string, 0, limit)
		if err := scanLines(r, func(line string) error {
			if limit <= 0 {
				return nil
			}
			if len(ring) == limit {
				ring = ring[1:]
			}
			ring = append(ring, line)
			return nil
		}); err != nil {
			return err
		}
		for _, l := range ring {
			fmt.Fprintln(c.out, l)
		}
		return nil
	})
}

func cmdWc(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	showAll := !f.set['l'] && !f.set['w'] && !f.set['c']
	return eachInput(c, f.rest, func(name string, r io.Reader) error {
		var lines, words, chars int
		if err := scanLines(r, func(line string) error {
			lines++
			words += len(strings.Fields(line))
			chars += len(line) + 1
			return nil
		}); err != nil {
			return err
		}
		var parts []string
		if showAll || f.set['l'] {
			parts = append(parts, strconv.Itoa(lines))
		}
		if showAll || f.set['w'] {
			parts = append(parts, strconv.Itoa(words))
		}
		if showAll || f.set['c'] {
			parts = append(parts, strconv.Itoa(chars))
		}
		if name != "" {
			parts = append(parts, name)
		}
		fmt.Fprintln(c.out, strings.Join(parts, "\t"))
		return nil
	})
}

func cmdGrep(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	if len(f.rest) == 0 {
		return fmt.Errorf("missing PATTERN")
	}
	expr := f.rest[0]
	if f.set['i'] {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return err
	}
	targets := f.rest[1:]

	// Scripts branch on grep's status, so track whether anything matched. -q
	// reports only through that status and prints nothing.
	matched := false

	emit := func(name string, r io.Reader) error {
		n := 0
		return scanLines(r, func(line string) error {
			n++
			hit := re.MatchString(line)
			if f.set['v'] {
				hit = !hit
			}
			if !hit {
				return nil
			}
			matched = true
			if f.set['q'] {
				return nil
			}
			prefix := ""
			if name != "" && (len(targets) > 1 || f.set['r']) {
				prefix = name + ":"
			}
			if f.set['n'] {
				prefix += strconv.Itoa(n) + ":"
			}
			fmt.Fprintln(c.out, prefix+line)
			return nil
		})
	}

	if f.set['r'] {
		roots := targets
		if len(roots) == 0 {
			roots = []string{"."}
		}
		for _, root := range roots {
			abs, err := c.resolve(root)
			if err != nil {
				return err
			}
			if err := walkFiles(abs, func(a string, _ fs.DirEntry) error {
				fh, err := os.Open(a)
				if err != nil {
					return nil
				}
				defer fh.Close()
				return emit(c.env.Rel(a), fh)
			}); err != nil {
				return err
			}
		}
		if !matched {
			return exitCodeError(1)
		}
		return nil
	}
	if err := eachInput(c, targets, emit); err != nil {
		return err
	}
	if !matched {
		return exitCodeError(1)
	}
	return nil
}

// splitSed parses `s<delim>pattern<delim>replacement<delim>flags`. Go's RE2
// has no backreferences, so the delimiter cannot be matched with a regex —
// scan for unescaped delimiters instead.
func splitSed(script string) (pattern, replacement, flags string, err error) {
	r := []rune(script)
	if len(r) < 4 || r[0] != 's' {
		return "", "", "", fmt.Errorf("only substitution is supported: s/pattern/replacement/[gi]")
	}
	delim := r[1]
	var parts []string
	var cur []rune
	escaped := false
	for _, ch := range r[2:] {
		switch {
		case escaped:
			// Keep the backslash: it may be a regex escape such as \d or \1.
			cur = append(cur, '\\', ch)
			escaped = false
		case ch == '\\':
			escaped = true
		case ch == delim:
			parts = append(parts, string(cur))
			cur = cur[:0]
		default:
			cur = append(cur, ch)
		}
	}
	parts = append(parts, string(cur))
	if len(parts) < 2 {
		return "", "", "", fmt.Errorf("malformed script %q: expected s%cpattern%creplacement%c[gi]",
			script, delim, delim, delim)
	}
	pattern, replacement = parts[0], parts[1]
	if len(parts) > 2 {
		flags = parts[2]
	}
	for _, f := range flags {
		if f != 'g' && f != 'i' {
			return "", "", "", fmt.Errorf("unsupported flag %q (only g and i are supported)", string(f))
		}
	}
	if pattern == "" {
		return "", "", "", fmt.Errorf("empty pattern")
	}
	return pattern, replacement, flags, nil
}

func cmdSed(c *cmdCtx) error {
	if len(c.args) == 0 {
		return fmt.Errorf("missing script, expected s/pattern/replacement/[g]")
	}
	pattern, replacement, flagStr, err := splitSed(c.args[0])
	if err != nil {
		return err
	}
	if strings.Contains(flagStr, "i") {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return err
	}
	global := strings.Contains(flagStr, "g")
	// sed uses \1 for backrefs; Go's Expand uses ${1}.
	repl := regexp.MustCompile(`\\(\d)`).ReplaceAllString(replacement, "${$1}")

	return eachInput(c, c.args[1:], func(_ string, r io.Reader) error {
		return scanLines(r, func(line string) error {
			if global {
				fmt.Fprintln(c.out, re.ReplaceAllString(line, repl))
				return nil
			}
			done := false
			out := re.ReplaceAllStringFunc(line, func(s string) string {
				if done {
					return s
				}
				done = true
				idx := re.FindStringSubmatchIndex(line)
				return string(re.ExpandString(nil, repl, line, idx))
			})
			fmt.Fprintln(c.out, out)
			return nil
		})
	})
}

func cmdSort(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	var lines []string
	if err := eachInput(c, f.rest, func(_ string, r io.Reader) error {
		return scanLines(r, func(l string) error { lines = append(lines, l); return nil })
	}); err != nil {
		return err
	}
	if f.set['n'] {
		sort.SliceStable(lines, func(i, j int) bool {
			a, _ := strconv.ParseFloat(strings.TrimSpace(strings.Fields(lines[i]+" ")[0]), 64)
			b, _ := strconv.ParseFloat(strings.TrimSpace(strings.Fields(lines[j]+" ")[0]), 64)
			return a < b
		})
	} else {
		sort.Strings(lines)
	}
	if f.set['r'] {
		for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
			lines[i], lines[j] = lines[j], lines[i]
		}
	}
	if f.set['u'] {
		var uniq []string
		for i, l := range lines {
			if i == 0 || l != lines[i-1] {
				uniq = append(uniq, l)
			}
		}
		lines = uniq
	}
	for _, l := range lines {
		fmt.Fprintln(c.out, l)
	}
	return nil
}

func cmdUniq(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	prev := ""
	count := 0
	first := true
	flush := func() {
		if first {
			return
		}
		if f.set['c'] {
			fmt.Fprintf(c.out, "%7d %s\n", count, prev)
		} else {
			fmt.Fprintln(c.out, prev)
		}
	}
	if err := eachInput(c, f.rest, func(_ string, r io.Reader) error {
		return scanLines(r, func(l string) error {
			if !first && l == prev {
				count++
				return nil
			}
			flush()
			prev, count, first = l, 1, false
			return nil
		})
	}); err != nil {
		return err
	}
	flush()
	return nil
}

func cmdCut(c *cmdCtx) error {
	f, err := parseFlags(c.args, "df")
	if err != nil {
		return err
	}
	delim := "\t"
	if v, ok := f.vals['d']; ok {
		delim = v
	}
	spec, ok := f.vals['f']
	if !ok {
		return fmt.Errorf("-f is required")
	}
	var fields []int
	for _, part := range strings.Split(spec, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n < 1 {
			return fmt.Errorf("invalid field %q", part)
		}
		fields = append(fields, n)
	}
	return eachInput(c, f.rest, func(_ string, r io.Reader) error {
		return scanLines(r, func(l string) error {
			cols := strings.Split(l, delim)
			var picked []string
			for _, n := range fields {
				if n <= len(cols) {
					picked = append(picked, cols[n-1])
				}
			}
			fmt.Fprintln(c.out, strings.Join(picked, delim))
			return nil
		})
	})
}

// expandSet turns a tr set such as "a-z0-9_" into its explicit runes, after
// interpreting the backslash escapes tr accepts.
func expandSet(s string) []rune {
	s = strings.NewReplacer(`\n`, "\n", `\t`, "\t", `\r`, "\r", `\\`, `\`).Replace(s)
	runes := []rune(s)
	var out []rune
	for i := 0; i < len(runes); i++ {
		if i+2 < len(runes) && runes[i+1] == '-' && runes[i+2] >= runes[i] {
			for r := runes[i]; r <= runes[i+2]; r++ {
				out = append(out, r)
			}
			i += 2
			continue
		}
		out = append(out, runes[i])
	}
	return out
}

func cmdTr(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	del := f.set['d']
	if (del && len(f.rest) < 1) || (!del && len(f.rest) < 2) {
		return fmt.Errorf("usage: tr SET1 SET2, or tr -d SET1")
	}

	from := expandSet(f.rest[0])
	var to []rune
	if !del {
		to = expandSet(f.rest[1])
	}
	index := func(r rune) int {
		for i, fr := range from {
			if r == fr {
				return i
			}
		}
		return -1
	}

	return scanLines(c.stdin(), func(l string) error {
		out := make([]rune, 0, len(l))
		for _, r := range l {
			i := index(r)
			switch {
			case i < 0:
				out = append(out, r)
			case del:
				// dropped
			case i < len(to):
				out = append(out, to[i])
			default:
				// A short SET2 repeats its last rune, as tr does.
				out = append(out, to[len(to)-1])
			}
		}
		fmt.Fprintln(c.out, string(out))
		return nil
	})
}

func cmdFind(c *cmdCtx) error {
	root := "."
	name := ""
	typ := ""
	args := c.args
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		root = args[0]
		args = args[1:]
	}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-name":
			if i+1 < len(args) {
				i++
				name = args[i]
			}
		case "-type":
			if i+1 < len(args) {
				i++
				typ = args[i]
			}
		}
	}
	abs, err := c.resolve(root)
	if err != nil {
		return err
	}
	return filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && p != abs && skipDirs[d.Name()] {
			return filepath.SkipDir
		}
		if typ == "f" && d.IsDir() {
			return nil
		}
		if typ == "d" && !d.IsDir() {
			return nil
		}
		if name != "" {
			if ok, _ := filepath.Match(name, d.Name()); !ok {
				return nil
			}
		}
		fmt.Fprintln(c.out, c.env.Rel(p))
		return nil
	})
}

func cmdStat(c *cmdCtx) error {
	if len(c.args) == 0 {
		return fmt.Errorf("missing file")
	}
	for _, p := range c.args {
		abs, err := c.resolve(p)
		if err != nil {
			return err
		}
		fi, err := os.Stat(abs)
		if err != nil {
			return err
		}
		kind := "file"
		if fi.IsDir() {
			kind = "dir"
		}
		fmt.Fprintf(c.out, "%s\t%s\t%d bytes\tmode %s\tmodified %s\n",
			p, kind, fi.Size(), fi.Mode().Perm(), fi.ModTime().Format("2006-01-02 15:04:05"))
	}
	return nil
}

func cmdDu(c *cmdCtx) error {
	root := "."
	if len(c.args) > 0 {
		root = c.args[0]
	}
	abs, err := c.resolve(root)
	if err != nil {
		return err
	}
	var total int64
	var files int
	if err := walkFiles(abs, func(p string, d fs.DirEntry) error {
		if info, err := d.Info(); err == nil {
			total += info.Size()
			files++
		}
		return nil
	}); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "%d files\t%.1f KiB\t%s\n", files, float64(total)/1024, root)
	return nil
}

func cmdWhich(c *cmdCtx) error {
	if len(c.args) == 0 {
		return fmt.Errorf("missing name")
	}
	for _, n := range c.args {
		if p, err := lookPath(n); err == nil {
			fmt.Fprintln(c.out, p)
		} else {
			fmt.Fprintf(c.out, "%s: not found\n", n)
		}
	}
	return nil
}

func cmdMkdir(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	for _, p := range f.rest {
		abs, err := c.resolve(p)
		if err != nil {
			return err
		}
		if f.set['p'] {
			err = os.MkdirAll(abs, 0o755)
		} else {
			err = os.Mkdir(abs, 0o755)
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(c.out, "created %s\n", p)
	}
	return nil
}

func cmdTouch(c *cmdCtx) error {
	for _, p := range c.args {
		abs, err := c.resolve(p)
		if err != nil {
			return err
		}
		if _, err := os.Stat(abs); os.IsNotExist(err) {
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return err
			}
			f, err := os.Create(abs)
			if err != nil {
				return err
			}
			f.Close()
			if c.env.FileChanged != nil {
				c.env.FileChanged(abs)
			}
			fmt.Fprintf(c.out, "created %s\n", p)
		} else {
			fmt.Fprintf(c.out, "exists %s\n", p)
		}
	}
	return nil
}

func cmdRm(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	if len(f.rest) == 0 {
		return fmt.Errorf("missing path")
	}
	for _, p := range f.rest {
		abs, err := c.resolve(p)
		if err != nil {
			return err
		}
		root, _ := filepath.Abs(c.env.Root)
		if abs == root {
			return fmt.Errorf("refusing to delete the workspace root")
		}
		fi, err := os.Stat(abs)
		if err != nil {
			if f.set['f'] {
				continue
			}
			return err
		}
		if fi.IsDir() && !f.set['r'] {
			return fmt.Errorf("%s is a directory (use -r)", p)
		}
		if f.set['r'] {
			err = os.RemoveAll(abs)
		} else {
			err = os.Remove(abs)
		}
		if err != nil {
			return err
		}
		if c.env.FileChanged != nil {
			c.env.FileChanged(abs)
		}
		fmt.Fprintf(c.out, "removed %s\n", p)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func cmdCp(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	if len(f.rest) != 2 {
		return fmt.Errorf("usage: cp [-r] src dst")
	}
	src, err := c.resolve(f.rest[0])
	if err != nil {
		return err
	}
	dst, err := c.resolve(f.rest[1])
	if err != nil {
		return err
	}
	fi, err := os.Stat(src)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		if !f.set['r'] {
			return fmt.Errorf("%s is a directory (use -r)", f.rest[0])
		}
		err = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(src, p)
			return copyFile(p, filepath.Join(dst, rel))
		})
	} else {
		if di, err := os.Stat(dst); err == nil && di.IsDir() {
			dst = filepath.Join(dst, filepath.Base(src))
		}
		err = copyFile(src, dst)
	}
	if err != nil {
		return err
	}
	if c.env.FileChanged != nil {
		c.env.FileChanged(dst)
	}
	fmt.Fprintf(c.out, "copied %s -> %s\n", f.rest[0], f.rest[1])
	return nil
}

func cmdMv(c *cmdCtx) error {
	if len(c.args) != 2 {
		return fmt.Errorf("usage: mv src dst")
	}
	src, err := c.resolve(c.args[0])
	if err != nil {
		return err
	}
	dst, err := c.resolve(c.args[1])
	if err != nil {
		return err
	}
	if di, err := os.Stat(dst); err == nil && di.IsDir() {
		dst = filepath.Join(dst, filepath.Base(src))
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		// Cross-device rename fails on Windows across volumes; fall back to copy.
		if err2 := copyFile(src, dst); err2 != nil {
			return err
		}
		_ = os.Remove(src)
	}
	if c.env.FileChanged != nil {
		c.env.FileChanged(src)
		c.env.FileChanged(dst)
	}
	fmt.Fprintf(c.out, "moved %s -> %s\n", c.args[0], c.args[1])
	return nil
}
