package tools

// Deciding, from a script's parse tree, whether running it can change anything.
//
// Nothing here asks permission — no tool does. Two other things depend on the
// answer:
//
//   - Ordering. The agent loop runs mutating calls serially in the order the
//     model asked for, and read-only ones in parallel. A `unix` script that
//     writes has to be sequenced against the edits around it; one that only
//     greps does not, and treating the whole tool as mutating would queue every
//     search behind every build for nothing.
//
//   - Visibility. summarizeUnix turns the answer into the line the chat shows
//     while the call runs. Since nothing pauses first, that line is the user's
//     only notice that a script is about to delete something, and "runs rm"
//     is the part worth reading — not the script text they would have to parse
//     themselves.
//
// The classifier is deliberately pessimistic: every branch it cannot decide
// resolves to "mutates". Being wrong in that direction costs a needlessly
// serialised call; being wrong the other way runs a write concurrently with
// the edit it conflicts with, and reports it to the user as a read.

import (
	"encoding/json"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// writeBuiltins are the builtins in posix.go that create, delete or rewrite
// something. Everything else there only reads or transforms a stream.
var writeBuiltins = map[string]bool{
	"mkdir": true, "touch": true, "rm": true, "cp": true, "mv": true, "tee": true,
}

// shellBuiltins are run by the interpreter itself and never reach dispatch, so
// they are deliberately absent from posix.go's table (see the comment there).
// The classifier still meets them as command names, and without this it would
// read every `echo` as an unknown host program and gate a script that cannot
// touch anything.
//
// Only names that cannot affect state outside the running script are listed.
// eval, exec, source, ., command, builtin, trap and kill are excluded on
// purpose: each one is a way to run something this classifier would then never
// see, so each counts as mutating.
var shellBuiltins = map[string]bool{
	"echo": true, "printf": true, "pwd": true, "test": true, "[": true,
	"true": true, "false": true, ":": true, "cd": true, "shift": true,
	"break": true, "continue": true, "return": true, "exit": true,
	"let": true, "getopts": true, "read": true, "times": true, "type": true,
	"hash": true, "umask": true, "unset": true, "set": true, "export": true,
	"local": true, "declare": true, "typeset": true, "readonly": true,
	"alias": true, "unalias": true, "shopt": true, "jobs": true, "wait": true,
}

// writingRedirs are the redirection operators that open a file for writing.
// Descriptor duplication (`2>&1`) and every input form are absent on purpose:
// they move an existing stream around without creating anything.
var writingRedirs = map[syntax.RedirOperator]bool{
	syntax.RdrOut:   true, // >
	syntax.AppOut:   true, // >>
	syntax.RdrInOut: true, // <>
	syntax.ClbOut:   true, // >|
	syntax.RdrAll:   true, // &>
	syntax.AppAll:   true, // &>>
}

// scriptMutates reports whether a script can change state, and why. The reason
// is not decoration: it is what the chat shows the user while the script runs,
// and "runs python on the host" tells them something "runs rm" does not.
func scriptMutates(script string) (bool, string) {
	f, err := syntax.NewParser().Parse(strings.NewReader(script), "")
	if err != nil {
		// runScript parses this same source and fails the same way, so the
		// script will not run either way. Reporting it as mutating keeps a
		// disagreement between the two parses from ever opening a hole.
		return true, "cannot be parsed"
	}

	var reason string
	syntax.Walk(f, func(node syntax.Node) bool {
		if reason != "" {
			return false // decided; stop descending
		}
		switch n := node.(type) {
		case *syntax.Redirect:
			if writingRedirs[n.Op] {
				reason = "writes to a file by redirection"
			}
		case *syntax.CallExpr:
			if len(n.Args) == 0 {
				return true // a bare assignment, `FOO=bar`
			}
			reason = commandMutates(litArgs(n.Args))
		}
		return reason == ""
	})
	return reason != "", reason
}

// litArgs flattens a command's words to strings, marking any word the parser
// cannot resolve statically — `$CMD`, `"${dir}/build.sh"` — with the empty
// string. Only the command name is ever required to be literal; an unresolved
// argument is fine, since the checks below look for fixed flags.
func litArgs(words []*syntax.Word) []string {
	out := make([]string, len(words))
	for i, w := range words {
		out[i] = w.Lit()
	}
	return out
}

// commandMutates returns why one command mutates, or "" if it only reads.
func commandMutates(args []string) string {
	name := args[0]
	if name == "" {
		// The name is computed at runtime, so there is nothing to classify.
		return "runs a command whose name is built at runtime"
	}
	if writeBuiltins[name] {
		return "runs " + name
	}
	if shellBuiltins[name] {
		return ""
	}
	if _, ok := builtins[name]; !ok {
		// No Go implementation: this falls through to the host shell and
		// becomes an arbitrary program. `python <<EOF` lands here, which is
		// the shape this classifier most needs to get right.
		return "runs " + name + " on the host"
	}

	// A read-only builtin — unless a flag turns it into a writing one. This
	// only bites where the host implementation is used (see hostPreferred:
	// the Go sed cannot write at all, GNU sed -i very much can), but the
	// check is platform-independent, so the answer does not change with which
	// utilities the host happens to have installed.
	switch name {
	case "sed":
		for _, a := range args[1:] {
			if a == "-i" || strings.HasPrefix(a, "-i.") || strings.HasPrefix(a, "--in-place") {
				return "runs sed in place"
			}
		}
	case "find":
		for _, a := range args[1:] {
			switch a {
			case "-delete", "-exec", "-execdir", "-ok", "-okdir":
				return "runs find " + a
			}
		}
	case "xargs":
		// xargs is a read-only utility that runs whatever follows it, so the
		// only honest answer is whatever that command's answer is.
		f, err := parseFlags(args[1:], "nI")
		if err != nil || len(f.rest) == 0 || f.rest[0] == "" {
			return "runs xargs"
		}
		return commandMutates(f.rest)
	}
	return ""
}

// unixMutatesOn adapts scriptMutates to the Tool.MutatesOn signature.
func unixMutatesOn(in json.RawMessage) bool {
	var a struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(in, &a); err != nil {
		return true
	}
	mutates, _ := scriptMutates(a.Command)
	return mutates
}

// summarizeUnix renders the chat's one-line label for a script. It leads with
// the reason a script mutates, because the script itself can be long and the
// reason is the part worth reading at a glance.
func summarizeUnix(in json.RawMessage) string {
	var a struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(in, &a); err != nil {
		return "unix"
	}
	script := strings.TrimSpace(a.Command)
	if i := strings.IndexByte(script, '\n'); i >= 0 {
		script = strings.TrimSpace(script[:i]) + " …"
	}
	if _, reason := scriptMutates(a.Command); reason != "" {
		return reason + "  —  " + script
	}
	return script
}
