package tools

// The rest of the POSIX toolbox. Same contract as posix.go: read from
// cmdCtx.in, write to cmdCtx.out, and route every path through cmdCtx.resolve
// so nothing reaches outside the workspace.

import (
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	awkinterp "github.com/benhoyt/goawk/interp"
	awkparser "github.com/benhoyt/goawk/parser"
)

// exitCodeError lets a builtin report a non-zero status without an error
// message, the way diff signals "files differ" and grep signals "no match".
// Anything else a builtin returns is a genuine failure and gets printed.
type exitCodeError uint8

func (e exitCodeError) Error() string { return fmt.Sprintf("exit status %d", uint8(e)) }

func (c *cmdCtx) stderr() io.Writer {
	if c.errw != nil {
		return c.errw
	}
	return io.Discard
}

func (c *cmdCtx) stdin() io.Reader {
	if c.in != nil {
		return c.in
	}
	return strings.NewReader("")
}

// readLines loads a file as lines with CRLF normalised away, so a script
// behaves the same against files checked out on Windows and on Linux.
func (c *cmdCtx) readLines(name string) ([]string, error) {
	abs, err := c.resolve(name)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	s := strings.ReplaceAll(string(data), "\r\n", "\n")
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return nil, nil
	}
	return strings.Split(s, "\n"), nil
}

// ---- awk ---------------------------------------------------------------

func cmdAwk(c *cmdCtx) error {
	var vars []string
	args := c.args
flags:
	for len(args) > 0 {
		switch {
		case args[0] == "-F" && len(args) > 1:
			vars = append(vars, "FS", args[1])
			args = args[2:]
		case strings.HasPrefix(args[0], "-F") && len(args[0]) > 2:
			vars = append(vars, "FS", args[0][2:])
			args = args[1:]
		case args[0] == "-v" && len(args) > 1:
			k, v, ok := strings.Cut(args[1], "=")
			if !ok {
				return fmt.Errorf("-v needs var=value, got %q", args[1])
			}
			vars = append(vars, k, v)
			args = args[2:]
		case strings.HasPrefix(args[0], "-v") && len(args[0]) > 2:
			k, v, ok := strings.Cut(args[0][2:], "=")
			if !ok {
				return fmt.Errorf("-v needs var=value, got %q", args[0][2:])
			}
			vars = append(vars, k, v)
			args = args[1:]
		default:
			break flags
		}
	}
	if len(args) == 0 {
		return fmt.Errorf("missing program")
	}

	prog, err := awkparser.ParseProgram([]byte(args[0]), nil)
	if err != nil {
		return err
	}

	in := c.stdin()
	if files := args[1:]; len(files) > 0 {
		readers := make([]io.Reader, 0, len(files))
		for _, name := range files {
			abs, err := c.resolve(name)
			if err != nil {
				return err
			}
			f, err := os.Open(abs)
			if err != nil {
				return err
			}
			defer f.Close()
			readers = append(readers, f)
		}
		in = io.MultiReader(readers...)
	}

	status, err := awkinterp.ExecProgram(prog, &awkinterp.Config{
		Stdin:   in,
		Output:  c.out,
		Error:   c.stderr(),
		Vars:    vars,
		Environ: []string{},
		// Input files are opened above through cmdCtx.resolve and output
		// redirection goes through the shell, so awk itself never touches the
		// filesystem or spawns anything on its own.
		NoExec:       true,
		NoFileWrites: true,
		NoFileReads:  true,
		// The default translates to CRLF on Windows, which would make the same
		// script emit different bytes per platform.
		NewlineOutput: awkinterp.RawNewlineMode,
	})
	if err != nil {
		return err
	}
	if status != 0 {
		return exitCodeError(status)
	}
	return nil
}

// ---- xargs -------------------------------------------------------------

func cmdXargs(c *cmdCtx) error {
	f, err := parseFlags(c.args, "nI")
	if err != nil {
		return err
	}
	if c.exec == nil {
		return fmt.Errorf("not available outside a script")
	}
	if len(f.rest) == 0 {
		return fmt.Errorf("missing command")
	}

	var items []string
	if err := scanLines(c.stdin(), func(line string) error {
		items = append(items, strings.Fields(line)...)
		return nil
	}); err != nil {
		return err
	}

	if repl, ok := f.vals['I']; ok {
		for _, item := range items {
			call := make([]string, len(f.rest))
			for i, a := range f.rest {
				call[i] = strings.ReplaceAll(a, repl, item)
			}
			if err := c.exec(c.ctx, call); err != nil {
				return err
			}
		}
		return nil
	}

	if len(items) == 0 {
		return c.exec(c.ctx, f.rest)
	}
	batch := len(items)
	if v, ok := f.vals['n']; ok {
		if batch, err = strconv.Atoi(v); err != nil || batch < 1 {
			return fmt.Errorf("invalid -n value %q", v)
		}
	}
	for i := 0; i < len(items); i += batch {
		end := i + batch
		if end > len(items) {
			end = len(items)
		}
		call := append(append([]string{}, f.rest...), items[i:end]...)
		if err := c.exec(c.ctx, call); err != nil {
			return err
		}
	}
	return nil
}

// ---- tee ---------------------------------------------------------------

func cmdTee(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	writers := []io.Writer{c.out}
	for _, name := range f.rest {
		abs, err := c.resolve(name)
		if err != nil {
			return err
		}
		flag := os.O_CREATE | os.O_WRONLY
		if f.set['a'] {
			flag |= os.O_APPEND
		} else {
			flag |= os.O_TRUNC
		}
		fh, err := os.OpenFile(abs, flag, 0o644)
		if err != nil {
			return err
		}
		defer func() {
			fh.Close()
			if c.env.FileChanged != nil {
				c.env.FileChanged(abs)
			}
		}()
		writers = append(writers, fh)
	}
	_, err = io.Copy(io.MultiWriter(writers...), c.stdin())
	return err
}

// ---- diff --------------------------------------------------------------

type diffOp struct {
	kind byte // ' ' kept, '-' only in old, '+' only in new
	text string
}

// diffOps aligns two line slices on their longest common subsequence. The
// table is O(len(a)*len(b)) so callers must bound the inputs first.
func diffOps(a, b []string) []diffOp {
	n, m := len(a), len(b)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}

	var ops []diffOp
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			ops = append(ops, diffOp{' ', a[i]})
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			ops = append(ops, diffOp{'-', a[i]})
			i++
		default:
			ops = append(ops, diffOp{'+', b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, diffOp{'-', a[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, diffOp{'+', b[j]})
	}
	return ops
}

func cmdDiff(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	if len(f.rest) != 2 {
		return fmt.Errorf("need exactly two files")
	}
	a, err := c.readLines(f.rest[0])
	if err != nil {
		return err
	}
	b, err := c.readLines(f.rest[1])
	if err != nil {
		return err
	}

	// Bound the LCS table rather than exhausting memory on large files.
	if len(a)*len(b) > 4_000_000 {
		same := len(a) == len(b)
		for i := range a {
			if same && a[i] != b[i] {
				same = false
				break
			}
		}
		if same {
			return nil
		}
		return fmt.Errorf("files are too large to diff line by line (%d and %d lines)", len(a), len(b))
	}

	ops := diffOps(a, b)
	differs := false
	for _, op := range ops {
		if op.kind != ' ' {
			differs = true
			break
		}
	}
	if !differs {
		return nil
	}

	if f.set['u'] {
		writeUnified(c.out, f.rest[0], f.rest[1], ops)
	} else {
		for _, op := range ops {
			switch op.kind {
			case '-':
				fmt.Fprintf(c.out, "< %s\n", op.text)
			case '+':
				fmt.Fprintf(c.out, "> %s\n", op.text)
			}
		}
	}
	// Real diff exits 1 when the files differ; scripts branch on that.
	return exitCodeError(1)
}

func writeUnified(w io.Writer, oldName, newName string, ops []diffOp) {
	const context = 3

	keep := make([]bool, len(ops))
	for i, op := range ops {
		if op.kind == ' ' {
			continue
		}
		lo, hi := i-context, i+context
		if lo < 0 {
			lo = 0
		}
		if hi >= len(ops) {
			hi = len(ops) - 1
		}
		for k := lo; k <= hi; k++ {
			keep[k] = true
		}
	}

	fmt.Fprintf(w, "--- %s\n+++ %s\n", oldName, newName)
	oldLine, newLine := 1, 1
	for i := 0; i < len(ops); {
		if !keep[i] {
			if ops[i].kind != '+' {
				oldLine++
			}
			if ops[i].kind != '-' {
				newLine++
			}
			i++
			continue
		}
		start, oStart, nStart := i, oldLine, newLine
		oCount, nCount := 0, 0
		for i < len(ops) && keep[i] {
			if ops[i].kind != '+' {
				oldLine++
				oCount++
			}
			if ops[i].kind != '-' {
				newLine++
				nCount++
			}
			i++
		}
		fmt.Fprintf(w, "@@ -%d,%d +%d,%d @@\n", oStart, oCount, nStart, nCount)
		for _, op := range ops[start:i] {
			fmt.Fprintf(w, "%c%s\n", op.kind, op.text)
		}
	}
}

// ---- small utilities ---------------------------------------------------

func cmdBasename(c *cmdCtx) error {
	if len(c.args) == 0 {
		return fmt.Errorf("missing operand")
	}
	base := path.Base(filepath.ToSlash(c.args[0]))
	if len(c.args) > 1 && base != c.args[1] {
		base = strings.TrimSuffix(base, c.args[1])
	}
	fmt.Fprintln(c.out, base)
	return nil
}

func cmdDirname(c *cmdCtx) error {
	if len(c.args) == 0 {
		return fmt.Errorf("missing operand")
	}
	for _, p := range c.args {
		fmt.Fprintln(c.out, path.Dir(filepath.ToSlash(p)))
	}
	return nil
}

func cmdSeq(c *cmdCtx) error {
	first, incr, last := 1.0, 1.0, 0.0
	var err error
	switch len(c.args) {
	case 1:
		last, err = strconv.ParseFloat(c.args[0], 64)
	case 2:
		if first, err = strconv.ParseFloat(c.args[0], 64); err == nil {
			last, err = strconv.ParseFloat(c.args[1], 64)
		}
	case 3:
		if first, err = strconv.ParseFloat(c.args[0], 64); err == nil {
			if incr, err = strconv.ParseFloat(c.args[1], 64); err == nil {
				last, err = strconv.ParseFloat(c.args[2], 64)
			}
		}
	default:
		return fmt.Errorf("usage: seq [first [incr]] last")
	}
	if err != nil {
		return err
	}
	if incr == 0 {
		return fmt.Errorf("increment must not be zero")
	}
	for v := first; (incr > 0 && v <= last) || (incr < 0 && v >= last); v += incr {
		if v == math.Trunc(v) {
			fmt.Fprintln(c.out, strconv.FormatInt(int64(v), 10))
		} else {
			fmt.Fprintln(c.out, strconv.FormatFloat(v, 'g', -1, 64))
		}
	}
	return nil
}

func cmdRev(c *cmdCtx) error {
	return eachInput(c, c.args, func(_ string, r io.Reader) error {
		return scanLines(r, func(line string) error {
			runes := []rune(line)
			for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
				runes[i], runes[j] = runes[j], runes[i]
			}
			fmt.Fprintln(c.out, string(runes))
			return nil
		})
	})
}

func cmdNl(c *cmdCtx) error {
	n := 0
	return eachInput(c, c.args, func(_ string, r io.Reader) error {
		return scanLines(r, func(line string) error {
			if strings.TrimSpace(line) == "" {
				fmt.Fprintln(c.out)
				return nil
			}
			n++
			fmt.Fprintf(c.out, "%6d\t%s\n", n, line)
			return nil
		})
	})
}

// cmdComm expects both files sorted, as POSIX comm does.
func cmdComm(c *cmdCtx) error {
	f, err := parseFlags(c.args, "")
	if err != nil {
		return err
	}
	if len(f.rest) != 2 {
		return fmt.Errorf("need exactly two files")
	}
	a, err := c.readLines(f.rest[0])
	if err != nil {
		return err
	}
	b, err := c.readLines(f.rest[1])
	if err != nil {
		return err
	}

	emit := func(col int, line string) {
		if f.set[byte('0'+col)] {
			return
		}
		fmt.Fprintln(c.out, strings.Repeat("\t", col-1)+line)
	}
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			emit(3, a[i])
			i, j = i+1, j+1
		case a[i] < b[j]:
			emit(1, a[i])
			i++
		default:
			emit(2, b[j])
			j++
		}
	}
	for ; i < len(a); i++ {
		emit(1, a[i])
	}
	for ; j < len(b); j++ {
		emit(2, b[j])
	}
	return nil
}

func cmdPaste(c *cmdCtx) error {
	f, err := parseFlags(c.args, "d")
	if err != nil {
		return err
	}
	delim := "\t"
	if v, ok := f.vals['d']; ok && v != "" {
		delim = v
	}
	if len(f.rest) == 0 {
		return fmt.Errorf("missing file")
	}

	// "-" means stdin. Several of them share one stream round-robin, so
	// `paste - -` folds a list into two columns the way real paste does.
	dashes := 0
	for _, name := range f.rest {
		if name == "-" {
			dashes++
		}
	}
	var piped []string
	if dashes > 0 {
		if err := scanLines(c.stdin(), func(l string) error {
			piped = append(piped, l)
			return nil
		}); err != nil {
			return err
		}
	}

	cols := make([][]string, len(f.rest))
	longest, dashIndex := 0, 0
	for i, name := range f.rest {
		if name == "-" {
			for k := dashIndex; k < len(piped); k += dashes {
				cols[i] = append(cols[i], piped[k])
			}
			dashIndex++
		} else {
			lines, err := c.readLines(name)
			if err != nil {
				return err
			}
			cols[i] = lines
		}
		if len(cols[i]) > longest {
			longest = len(cols[i])
		}
	}
	for i := 0; i < longest; i++ {
		parts := make([]string, len(cols))
		for j, col := range cols {
			if i < len(col) {
				parts[j] = col[i]
			}
		}
		fmt.Fprintln(c.out, strings.Join(parts, delim))
	}
	return nil
}
