package main

// The `mfcore sh` subcommand: run one script through the same portable shell
// the agent's `unix` tool uses, for callers that are not the agent.
//
// It exists because the extension has to run a task's verification command, and
// a check is only worth running if it means the same thing as the work it is
// checking. The agent builds with `go build ./... && npm test`; if the check
// then goes to PowerShell 5.1, `&&` is a syntax error and the task fails for a
// reason that has nothing to do with the code. Same interpreter, same result.
//
// Two deliberate choices make this immune to the quoting bugs that come with
// shelling out on Windows:
//
//   - the script arrives on stdin, never as an argument, so no command-line
//     parser between here and the caller ever sees it;
//   - the result leaves as a JSON envelope on stdout, so "the script exited 1"
//     and "the script could not be parsed" are different fields rather than two
//     exit codes the caller has to guess between.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/mflores/mfagent/core/internal/tools"
)

type shResult struct {
	Output string `json:"output"`
	Code   int    `json:"code"`
	// Invalid marks a script that never ran: a syntax error, or a shell that
	// could not start. It is a defect in the command, not a verdict on the code
	// the command was meant to check, and the two must not be confused.
	Invalid bool   `json:"invalid"`
	Error   string `json:"error,omitempty"`
	// TimedOut distinguishes a check that hung from one that failed.
	TimedOut bool `json:"timedOut"`
	Elapsed  int  `json:"elapsedMs"`
}

// runSh implements `mfcore sh`. Returns the process exit code.
func runSh(argv []string) int {
	fs := flag.NewFlagSet("sh", flag.ContinueOnError)
	dir := fs.String("dir", "", "working directory (defaults to the current one)")
	asJSON := fs.Bool("json", false, "report the result as a JSON envelope on stdout")
	timeout := fs.Duration("timeout", 5*time.Minute, "give up after this long")
	if err := fs.Parse(argv); err != nil {
		return 2
	}

	script, err := io.ReadAll(os.Stdin)
	if err != nil {
		return emitSh(*asJSON, shResult{Invalid: true, Error: "could not read the script from stdin: " + err.Error()})
	}
	if strings.TrimSpace(string(script)) == "" {
		return emitSh(*asJSON, shResult{Invalid: true, Error: "no script on stdin"})
	}

	root := *dir
	if root == "" {
		if root, err = os.Getwd(); err != nil {
			return emitSh(*asJSON, shResult{Invalid: true, Error: "no working directory: " + err.Error()})
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	// Nothing here writes to the UI: there is no editor attached to a script
	// run from the command line.
	env := &tools.Env{
		Root:        root,
		Emit:        func(string, any) {},
		FileChanged: func(string) {},
	}

	start := time.Now()
	out, status, runErr := tools.RunScript(ctx, env, root, string(script))
	res := shResult{
		Output:   strings.TrimRight(out, "\r\n"),
		Code:     int(status),
		Elapsed:  int(time.Since(start).Milliseconds()),
		TimedOut: ctx.Err() == context.DeadlineExceeded,
	}
	if runErr != nil {
		// The interpreter itself refused — a parse error, or a shell that would
		// not start. The script never ran, so there is no exit code to report.
		res.Invalid = true
		res.Error = runErr.Error()
		res.Code = -1
	}
	if res.TimedOut && res.Error == "" {
		res.Error = fmt.Sprintf("the script was still running after %s", *timeout)
	}
	return emitSh(*asJSON, res)
}

// emitSh writes the result and returns the process exit code. In JSON mode the
// process exits 0 whatever the script did: the envelope carries the verdict,
// and overloading the exit code as well would just give the caller two sources
// of truth that can disagree.
func emitSh(asJSON bool, res shResult) int {
	if asJSON {
		b, err := json.Marshal(res)
		if err != nil {
			fmt.Fprintln(os.Stderr, "mfcore sh:", err)
			return 1
		}
		fmt.Println(string(b))
		return 0
	}

	if res.Output != "" {
		fmt.Println(res.Output)
	}
	if res.Error != "" {
		fmt.Fprintln(os.Stderr, "mfcore sh:", res.Error)
	}
	if res.Invalid {
		return 2
	}
	return res.Code
}
