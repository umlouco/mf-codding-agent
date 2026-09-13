package cognition

import (
	"strings"
	"testing"
)

// A previous run's observations must not each become their own "refresh this"
// focus item: on a multi-attempt task the whole prior journal is stale, and the
// per-item list filled working memory and prompted the model to re-run them.
func TestProjectCollapsesStaleObservations(t *testing.T) {
	s := NewState()
	s.Runs = map[string]string{"coder": "run-2"}
	s.Evidence = map[string]Evidence{
		"coder:write": {Action: "hashA", Observer: "coder", RunID: "run-1",
			Summary: "write_file path=cmd/visionprobe/main.go", LastSeq: 10},
		"coder:read": {Action: "hashB", Observer: "coder", RunID: "run-1",
			Summary: "read_file path=internal/vision/client.go", LastSeq: 12},
		"coder:shell": {Action: "hashC", Observer: "coder", RunID: "run-2",
			Summary: "run_shell command=gofmt -l internal/vision/", IsError: true,
			FailureSeq: 14, LastSeq: 14, Excerpt: "exit 1"},
	}

	out := Project(s, Scope{WorkID: "w", Observer: "coder", RunID: "run-2"})

	var stale, diagnose int
	for _, f := range out.Focus {
		switch f.Rule {
		case "refresh_observation":
			t.Fatalf("stale observations must not be listed individually: %+v", f)
		case "stale_observations":
			stale++
			if !strings.Contains(f.Detail, "2 earlier observation(s)") {
				t.Fatalf("stale aggregate should count both prior records: %q", f.Detail)
			}
			if f.Priority >= 25 {
				t.Fatalf("stale aggregate must not crowd out actionable items; priority=%d", f.Priority)
			}
		case "diagnose_failure":
			diagnose++
		}
	}
	if stale != 1 {
		t.Fatalf("want exactly one stale aggregate, got %d (%+v)", stale, out.Focus)
	}
	if diagnose != 1 {
		t.Fatalf("a current unresolved error must still be surfaced, got %d (%+v)", diagnose, out.Focus)
	}
}

// The model-facing context is plain lines, not the Snapshot JSON: the action
// key and evidence sequence numbers cost tokens and were mistaken for an output
// schema to echo.
func TestContextRendersPlainTextWithinBudget(t *testing.T) {
	snapshot := Snapshot{
		Version: PolicyVersion, WorkID: "w", Observer: "coder", Seq: 20, Epoch: 3,
		Focus: []Focus{
			{Rule: "diagnose_failure", Priority: 85, Action: "99ff40e0c7f358d4bd29960f18bbda35b462a72df8ef099e0953bec4a612ab6c",
				Evidence: []int64{88, 90}, Detail: "run_shell command=gofmt: returned a tool error."},
			{Rule: "recent_observation", Priority: 25, Action: "deadbeef",
				Evidence: []int64{91}, Detail: "read_file path=internal/vision/client.go: returned an observation."},
		},
		Omitted: 30,
	}

	if got := snapshot.Context(0); got != "" {
		t.Fatalf("zero budget must render nothing, got %q", got)
	}
	for _, budget := range []int{80, 200, 400, 2000} {
		got := snapshot.Context(budget)
		if len(got) > budget {
			t.Fatalf("budget %d exceeded: %d bytes", budget, len(got))
		}
		if strings.Contains(got, `"rule"`) || strings.Contains(got, "99ff40e0") {
			t.Fatalf("context must not be the raw snapshot JSON: %q", got)
		}
	}
	full := snapshot.Context(2000)
	if !strings.Contains(full, "- [85 diagnose_failure]") {
		t.Fatalf("actionable focus missing from rendered context: %q", full)
	}
	if !strings.Contains(full, "earlier item(s) omitted") {
		t.Fatalf("omitted count missing from rendered context: %q", full)
	}
}
