package browser

import (
	"context"
	"github.com/mflores/mfagent/core/internal/layout"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// findChrome mirrors the extension's detection just closely enough to locate a
// browser for the test, and reports "" when there is none to drive.
func findChrome() string {
	if p := os.Getenv("MFAGENT_CHROME_PATH"); p != "" {
		return p
	}
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		candidates = []string{
			`C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
			`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		}
	case "darwin":
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		}
	default:
		candidates = []string{
			"/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome",
		}
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// TestBrowserSurvivesAcrossCalls is the regression guard for the bug where the
// browser was launched by a Run whose context carried a startup timeout.
// chromedp binds the Chromium process to that context
// (exec.CommandContext in ExecAllocator.Allocate), so cancelling it tore the
// browser down the moment startup finished and every subsequent tool call
// failed with "context canceled". One navigation is not enough to catch it —
// the second call is the one that used to break.
func TestBrowserSurvivesAcrossCalls(t *testing.T) {
	exe := findChrome()
	if exe == "" {
		t.Skip("no Chrome/Edge/Chromium found; set MFAGENT_CHROME_PATH to run")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><title>probe</title></head>
			<body><h1 id="hd">hello</h1><button id="btn">go</button></body></html>`))
	}))
	defer srv.Close()

	b := New(exe, true, filepath.Join(t.TempDir(), "shots"), "")
	defer b.Close()

	ctx := context.Background()

	st, err := b.Navigate(ctx, srv.URL, "#hd")
	if err != nil {
		t.Fatalf("first navigate: %v", err)
	}
	if st.Title != "probe" {
		t.Fatalf("title = %q, want %q", st.Title, "probe")
	}

	// The call that regressed.
	if _, err := b.State(ctx); err != nil {
		t.Fatalf("State after navigate: %v", err)
	}

	els, err := b.Interactive(ctx)
	if err != nil {
		t.Fatalf("Interactive: %v", err)
	}
	if len(els) == 0 {
		t.Fatal("Interactive returned no elements, want the button")
	}

	if _, err := b.Navigate(ctx, srv.URL, "#hd"); err != nil {
		t.Fatalf("second navigate: %v", err)
	}
	if _, err := b.Screenshot(ctx, "", false); err != nil {
		t.Fatalf("Screenshot: %v", err)
	}
	if !b.Running() {
		t.Fatal("browser reports not running after a full sequence")
	}
	capture, err := b.CaptureLayout(ctx, layout.Spec{Width: 800, Height: 600, Criteria: []layout.Criterion{{ID: "heading", Requirement: "Heading is visible", Selectors: []string{"#hd"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if !capture.Stable || len(capture.PNG) == 0 || !strings.Contains(string(capture.DOM), `"width":800`) {
		t.Fatalf("bad layout capture: stable=%v DOM=%s", capture.Stable, capture.DOM)
	}
}

// TestReopenAfterClose covers the other half of the lifetime handling: once the
// browser is closed the next call has to bring a fresh one up rather than
// reusing the dead contexts.
func TestReopenAfterClose(t *testing.T) {
	exe := findChrome()
	if exe == "" {
		t.Skip("no Chrome/Edge/Chromium found; set MFAGENT_CHROME_PATH to run")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body><p id="p">ok</p></body></html>`))
	}))
	defer srv.Close()

	b := New(exe, true, filepath.Join(t.TempDir(), "shots"), "")
	defer b.Close()

	ctx := context.Background()
	if _, err := b.Navigate(ctx, srv.URL, "#p"); err != nil {
		t.Fatalf("navigate: %v", err)
	}

	b.Close()
	if b.Running() {
		t.Fatal("Running() true directly after Close()")
	}

	if _, err := b.Navigate(ctx, srv.URL, "#p"); err != nil {
		t.Fatalf("navigate after close: %v", err)
	}
}

// TestProfilePersistsAcrossClose is the guard for the persistent-profile fix:
// the queue spawns a fresh core per task, so a cookie set under one Browser
// must still be readable after Close() when both share a user-data dir — that
// is what lets a login survive from one task to the next. A second Browser on
// the same profile stands in for the next task's throwaway core.
func TestProfilePersistsAcrossClose(t *testing.T) {
	exe := findChrome()
	if exe == "" {
		t.Skip("no Chrome/Edge/Chromium found; set MFAGENT_CHROME_PATH to run")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><body><p id="p">ok</p></body></html>`))
	}))
	defer srv.Close()

	profile := filepath.Join(t.TempDir(), "profile")

	first := New(exe, true, filepath.Join(t.TempDir(), "shots1"), profile)
	ctx := context.Background()
	if _, err := first.Navigate(ctx, srv.URL, "#p"); err != nil {
		t.Fatalf("first navigate: %v", err)
	}
	// A non-HttpOnly cookie so document.cookie can read it back.
	if _, err := first.Eval(ctx, `document.cookie = 'ecrf_probe=42; path=/; max-age=3600'`); err != nil {
		t.Fatalf("set cookie: %v", err)
	}
	first.Close()

	// A separate Browser on the same profile — the next task's core.
	second := New(exe, true, filepath.Join(t.TempDir(), "shots2"), profile)
	defer second.Close()
	if _, err := second.Navigate(ctx, srv.URL, "#p"); err != nil {
		t.Fatalf("second navigate: %v", err)
	}
	got, err := second.Eval(ctx, `document.cookie`)
	if err != nil {
		t.Fatalf("read cookie: %v", err)
	}
	if !strings.Contains(got, "ecrf_probe=42") {
		t.Fatalf("cookie did not persist across profile reuse: got %q", got)
	}
}
