package layout

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/mflores/mfagent/core/internal/llm"
)

type fakeVision struct {
	calls    int
	response string
	request  llm.Request
}

func (p *fakeVision) Name() string  { return "fake" }
func (p *fakeVision) Model() string { return "vision-test" }
func (p *fakeVision) Stream(_ context.Context, req llm.Request, _ func(llm.Event)) (*llm.Turn, error) {
	p.calls++
	p.request = req
	return &llm.Turn{Blocks: []llm.Block{{Type: llm.BlockText, Text: p.response}}, Usage: llm.Usage{Input: 10, Output: 5}}, nil
}
func spec() Spec {
	return Spec{Width: 800, Height: 600, Criteria: []Criterion{{ID: "nav", Requirement: "Navigation fits on one row", Selectors: []string{"nav"}}}}
}

func TestReviewCarriesImageAndSavesEvidence(t *testing.T) {
	p := &fakeVision{response: `{"checks":[{"id":"nav","status":"PASS","observation":"Navigation is on one row."}]}`}
	capture := Capture{PNG: []byte("test-image"), DOM: json.RawMessage(`{"url":"http://localhost/","elements":[{"selector":"nav","count":1,"visible":true,"rect":{"x":0,"y":0,"width":600,"height":50}}]}`), Stable: true, Engine: "test"}
	root := t.TempDir()
	report, err := Review(context.Background(), root, spec(), capture, p)
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "PASS" || report.Usage.Input != 10 {
		t.Fatalf("report=%+v", report)
	}
	if len(p.request.Tools) != 0 || p.request.Messages[0].Blocks[1].Type != llm.BlockImage {
		t.Fatal("vision must get an image and no tools")
	}
	for _, name := range []string{"screenshot.png", "capture.json", "report.json"} {
		if _, err := os.Stat(filepath.Join(filepath.Dir(report.Artifact), name)); err != nil {
			t.Fatal(err)
		}
	}
	capture.Stable = false
	report, err = Review(context.Background(), root, spec(), capture, p)
	if err != nil || report.Status != "INCOMPLETE" || p.calls != 1 {
		t.Fatal("unstable capture reached vision or passed")
	}
}

func TestVisionCannotPassMissingAnchor(t *testing.T) {
	p := &fakeVision{response: `{"checks":[{"id":"nav","status":"PASS","observation":"Looks fine"}]}`}
	report, err := Review(context.Background(), t.TempDir(), spec(), Capture{PNG: []byte("png"), DOM: json.RawMessage(`{"elements":[]}`), Stable: true}, p)
	if err != nil || report.Status != "INCOMPLETE" || report.Checks[0].Status != "UNCERTAIN" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
}

func TestMalformedOrMissingCriteriaCannotPass(t *testing.T) {
	for _, raw := range []string{
		`{"checks":[]}`, `{"checks":[{"id":"invented","status":"PASS","observation":"ok"}]}`,
		`{"checks":[{"id":"nav","status":"PASS","observation":""}]}`,
		`{"checks":[{"id":"nav","status":"PASS","observation":"ok"}]} trailing`,
		`{"checks":[{"id":"nav","status":"PASS","observation":"ok"}],"verdict":"PASS"}`,
	} {
		if _, err := ParseChecks(raw, spec()); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func TestMissingVisionIsIncomplete(t *testing.T) {
	report, err := Review(context.Background(), t.TempDir(), spec(), Capture{PNG: []byte("png"), DOM: json.RawMessage(`{}`), Stable: true}, nil)
	if err != nil || report.Status != "INCOMPLETE" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
}
