package main

// The `mfcore scan` subcommand: a deterministic, non-LLM partition of a
// workspace into regions no larger than a given file-count ceiling.
//
// It exists so the queue's planner never has to ask a model to judge whether
// a slice of the codebase is "too big to explore in one turn" — that is a
// question code can answer exactly, by counting files, and it answers it once
// up front rather than leaving a model to size its own work mid-turn. Same
// stdin-free, JSON-envelope-on-stdout shape as `mfcore sh`, for the same
// reason: nothing here should depend on a shell to invoke correctly.

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/mflores/mfagent/core/internal/tools"
)

type scanResult struct {
	Regions []tools.Region `json:"regions"`
	Error   string         `json:"error,omitempty"`
}

// runScan implements `mfcore scan`. Returns the process exit code.
func runScan(argv []string) int {
	fs := flag.NewFlagSet("scan", flag.ContinueOnError)
	dir := fs.String("dir", "", "workspace root to scan (defaults to the current directory)")
	asJSON := fs.Bool("json", false, "report the result as a JSON envelope on stdout")
	maxPerRegion := fs.Int("max-per-region", 150, "largest file count one region may hold before it is split further")
	if err := fs.Parse(argv); err != nil {
		return 2
	}

	root := *dir
	if root == "" {
		var err error
		if root, err = os.Getwd(); err != nil {
			return emitScan(*asJSON, scanResult{Error: "no working directory: " + err.Error()})
		}
	}

	regions, err := tools.ScanRegions(root, *maxPerRegion)
	if err != nil {
		return emitScan(*asJSON, scanResult{Error: err.Error()})
	}
	return emitScan(*asJSON, scanResult{Regions: regions})
}

// emitScan writes the result and returns the process exit code. In JSON mode
// the process exits 0 as long as the envelope itself could be produced: the
// envelope carries the verdict, same as `mfcore sh --json`.
func emitScan(asJSON bool, res scanResult) int {
	if asJSON {
		b, err := json.Marshal(res)
		if err != nil {
			fmt.Fprintln(os.Stderr, "mfcore scan:", err)
			return 1
		}
		fmt.Println(string(b))
		return 0
	}

	if res.Error != "" {
		fmt.Fprintln(os.Stderr, "mfcore scan:", res.Error)
		return 1
	}
	for _, r := range res.Regions {
		fmt.Printf("%-40s %d files\n", r.Path, r.FileCount)
	}
	return 0
}
