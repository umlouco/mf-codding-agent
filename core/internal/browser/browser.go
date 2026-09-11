// Package browser drives a real Chromium instance over the Chrome DevTools
// Protocol so the agent can test web work end to end — navigate, interact,
// read the DOM, capture screenshots and collect console errors — without
// pulling in Playwright or any Node tooling.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

type LogEntry struct {
	Level string `json:"level"`
	Text  string `json:"text"`
	When  int64  `json:"when"`
}

type Browser struct {
	mu sync.Mutex

	allocCancel context.CancelFunc
	ctxCancel   context.CancelFunc
	ctx         context.Context

	logs    []LogEntry
	logsMu  sync.Mutex
	started bool

	execPath   string
	fallbacks  []string
	resolved   string
	headless   bool
	shotDir    string
	profileDir string
}

// Resolved reports which executable actually started, for status output. Empty
// means chromedp found one on its own, or nothing has started yet.
func (b *Browser) Resolved() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.resolved
}

func describePath(p string) string {
	if p == "" {
		return "chromedp's own search"
	}
	return p
}

// condense keeps a launch failure to one line. Chromium writes a paragraph of
// sandbox advice on every failed start, and one per candidate would bury the
// list the reader actually needs.
func condense(err error) string {
	line := strings.TrimSpace(strings.SplitN(err.Error(), "\n", 2)[0])
	if len(line) > 200 {
		line = line[:200] + "…"
	}
	return line
}

// New builds a Browser. profileDir, when non-empty, is a persistent Chromium
// user-data directory: cookies and session storage survive process exit, so a
// login done in one core process is still valid in the next. Pass "" for an
// ephemeral profile.
func New(execPath string, headless bool, shotDir, profileDir string) *Browser {
	return &Browser{execPath: execPath, headless: headless, shotDir: shotDir, profileDir: profileDir}
}

// SetFallbacks supplies further browser executables to try when the primary
// one will not start. The usual source is Playwright's own downloaded
// Chromium: on a server with no system browser that is normally the only build
// present, and it is the same one the project's specs run against.
//
// The list is supplied by the caller rather than discovered here so this
// package keeps knowing nothing about Playwright.
func (b *Browser) SetFallbacks(paths []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.fallbacks = paths
}

// Candidates is the launch order: the configured executable first, then each
// fallback, then an empty path that lets chromedp search for itself.
func (b *Browser) Candidates() []string {
	out := make([]string, 0, len(b.fallbacks)+2)
	seen := map[string]bool{}
	for _, p := range append([]string{b.execPath}, append(b.fallbacks, "")...) {
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// ensure starts a browser, trying each candidate in turn.
//
// A missing system Chrome used to end the turn here. It no longer should: the
// machine nearly always has a browser somewhere, and which one it is matters
// far less than whether the check runs at all.
func (b *Browser) ensure(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.started && b.ctx != nil && b.ctx.Err() == nil {
		return nil
	}

	var attempts []string
	for _, candidate := range b.Candidates() {
		err := b.launch(ctx, candidate)
		if err == nil {
			b.resolved = candidate
			return nil
		}
		if ctx.Err() != nil {
			return err
		}
		attempts = append(attempts, fmt.Sprintf("  %s: %v", describePath(candidate), condense(err)))
	}
	return fmt.Errorf("no browser could be started. Tried:\n%s\n\n"+
		"Every candidate failed, so browser_* tools cannot produce evidence here. "+
		"Use browser_show to display the page to the user (display only, not evidence), "+
		"or report a blocked environment.", strings.Join(attempts, "\n"))
}

func (b *Browser) launch(ctx context.Context, execPath string) error {
	// A previous browser died (closed by hand, or crashed). Release its
	// contexts before allocating a replacement so the process and its
	// user-data dir do not leak.
	if b.ctxCancel != nil {
		b.ctxCancel()
		b.ctxCancel = nil
	}
	if b.allocCancel != nil {
		b.allocCancel()
		b.allocCancel = nil
	}
	b.started = false
	b.ctx = nil

	opts := append([]chromedp.ExecAllocatorOption{},
		chromedp.NoFirstRun,
		chromedp.NoDefaultBrowserCheck,
		chromedp.Flag("headless", b.headless),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("hide-scrollbars", false),
		chromedp.Flag("mute-audio", true),
		chromedp.WindowSize(1440, 900),
	)
	if execPath != "" {
		opts = append(opts, chromedp.ExecPath(execPath))
	}
	if b.profileDir != "" {
		// Never remove Chromium's lock: another process may own this profile.
		if err := os.MkdirAll(b.profileDir, 0o755); err == nil {
			opts = append(opts, chromedp.UserDataDir(b.profileDir))
		}
	}

	if goruntime.GOOS == "linux" {
		// Servers reached over SSH are routinely containers with a small
		// /dev/shm, where Chromium's shared-memory allocation fails and the
		// tab crashes mid-render. Writing to /tmp instead is slower and
		// always works.
		opts = append(opts, chromedp.Flag("disable-dev-shm-usage", true))

		// Chromium refuses to start as root unless sandboxing is off, and
		// root is the norm in the containers this runs in. Scope it to that
		// case rather than dropping the sandbox everywhere.
		if os.Geteuid() == 0 {
			opts = append(opts,
				chromedp.NoSandbox,
				chromedp.Flag("disable-setuid-sandbox", true),
			)
		}
	}

	// Detach from the request context: the browser outlives a single turn.
	allocCtx, allocCancel := chromedp.NewExecAllocator(context.Background(), opts...)
	bctx, bcancel := chromedp.NewContext(allocCtx)

	// Surface page console output and uncaught exceptions — the single most
	// useful signal when checking whether a change actually works.
	chromedp.ListenTarget(bctx, func(ev any) {
		switch e := ev.(type) {
		case *runtime.EventConsoleAPICalled:
			var parts []string
			for _, a := range e.Args {
				parts = append(parts, argText(a))
			}
			b.appendLog(string(e.Type), strings.Join(parts, " "))
		case *runtime.EventExceptionThrown:
			if e.ExceptionDetails != nil {
				b.appendLog("exception", e.ExceptionDetails.Error())
			}
		}
	})

	// The first Run is what actually launches Chromium, and chromedp ties the
	// browser process to the context it is handed there —
	// exec.CommandContext(ctx, ...) inside ExecAllocator.Allocate. A
	// context.WithTimeout here would therefore kill the browser as soon as that
	// context was cancelled, leaving every later call to fail with "context
	// canceled". So the first Run gets bctx, which lives as long as the
	// browser should, and the startup deadline is enforced from outside.
	startErr := make(chan error, 1)
	go func() { startErr <- chromedp.Run(bctx) }()

	select {
	case <-ctx.Done():
		bcancel()
		allocCancel()
		return ctx.Err()
	case err := <-startErr:
		if err != nil {
			bcancel()
			allocCancel()
			return err
		}
	case <-time.After(45 * time.Second):
		bcancel()
		allocCancel()
		return errors.New("timed out after 45s")
	}

	b.allocCancel = allocCancel
	b.ctxCancel = bcancel
	b.ctx = bctx
	b.started = true
	return nil
}

func argText(a *runtime.RemoteObject) string {
	if a == nil {
		return ""
	}
	if len(a.Value) > 0 {
		var v any
		if json.Unmarshal(a.Value, &v) == nil {
			return fmt.Sprint(v)
		}
		return string(a.Value)
	}
	if a.Description != "" {
		return a.Description
	}
	return string(a.Type)
}

func (b *Browser) appendLog(level, text string) {
	b.logsMu.Lock()
	defer b.logsMu.Unlock()
	b.logs = append(b.logs, LogEntry{Level: level, Text: text, When: time.Now().UnixMilli()})
	if len(b.logs) > 500 {
		b.logs = b.logs[len(b.logs)-500:]
	}
}

func (b *Browser) Logs(clear bool) []LogEntry {
	b.logsMu.Lock()
	defer b.logsMu.Unlock()
	out := make([]LogEntry, len(b.logs))
	copy(out, b.logs)
	if clear {
		b.logs = nil
	}
	return out
}

func (b *Browser) ClearLogs() {
	b.logsMu.Lock()
	defer b.logsMu.Unlock()
	b.logs = nil
}

func (b *Browser) run(ctx context.Context, timeout time.Duration, actions ...chromedp.Action) error {
	if err := b.ensure(ctx); err != nil {
		return err
	}
	b.mu.Lock()
	base := b.ctx
	b.mu.Unlock()

	tctx, cancel := context.WithTimeout(base, timeout)
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	return chromedp.Run(tctx, actions...)
}

type PageState struct {
	URL     string     `json:"url"`
	Title   string     `json:"title"`
	Text    string     `json:"text"`
	Console []LogEntry `json:"console,omitempty"`
}

func (b *Browser) Navigate(ctx context.Context, url string, waitFor string) (*PageState, error) {
	b.ClearLogs()
	actions := []chromedp.Action{chromedp.Navigate(url)}
	if waitFor != "" {
		actions = append(actions, chromedp.WaitVisible(waitFor, chromedp.ByQuery))
	} else {
		actions = append(actions, chromedp.Sleep(400*time.Millisecond))
	}
	if err := b.run(ctx, 45*time.Second, actions...); err != nil {
		return nil, err
	}
	return b.State(ctx)
}

// visibleTextJS extracts rendered text, skipping script/style and hidden
// nodes. innerText alone misses shadow content but is close enough, and much
// cheaper than serialising the whole DOM into the model's context.
const visibleTextJS = `(() => {
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG']);
  const walk = (node, out) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = child.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      } else if (child.nodeType === 1 && !skip.has(child.tagName)) {
        const cs = getComputedStyle(child);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        walk(child, out);
        if (/^(P|DIV|SECTION|LI|TR|H1|H2|H3|H4|H5|H6|BR|ARTICLE)$/.test(child.tagName)) out.push('\n');
      }
    }
    return out;
  };
  return walk(document.body || document.documentElement, [])
    .join(' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
})()`

func (b *Browser) State(ctx context.Context) (*PageState, error) {
	st := &PageState{}
	err := b.run(ctx, 20*time.Second,
		chromedp.Location(&st.URL),
		chromedp.Title(&st.Title),
		chromedp.Evaluate(visibleTextJS, &st.Text),
	)
	if err != nil {
		return nil, err
	}
	if len(st.Text) > 20000 {
		st.Text = st.Text[:20000] + "\n… (page text truncated)"
	}
	st.Console = b.Logs(false)
	return st, nil
}

// interactiveJS lists the elements an agent can act on, with a stable CSS
// selector for each. This is the compact alternative to dumping raw HTML.
const interactiveJS = `(() => {
  const sel = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let p = n.tagName.toLowerCase();
      if (n.parentNode) {
        const sibs = [...n.parentNode.children].filter(c => c.tagName === n.tagName);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const out = [];
  const nodes = document.querySelectorAll(
    'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[onclick]');
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      label: (el.innerText || el.value || el.getAttribute('aria-label') ||
              el.getAttribute('placeholder') || el.getAttribute('title') || '')
             .replace(/\s+/g,' ').trim().slice(0, 80),
      selector: sel(el),
      disabled: !!el.disabled,
    });
    if (out.length >= 120) break;
  }
  return out;
})()`

type Element struct {
	Tag      string `json:"tag"`
	Type     string `json:"type"`
	Label    string `json:"label"`
	Selector string `json:"selector"`
	Disabled bool   `json:"disabled"`
}

func (b *Browser) Interactive(ctx context.Context) ([]Element, error) {
	var els []Element
	if err := b.run(ctx, 20*time.Second, chromedp.Evaluate(interactiveJS, &els)); err != nil {
		return nil, err
	}
	return els, nil
}

func (b *Browser) Click(ctx context.Context, selector string) error {
	return selectorError(b.run(ctx, 20*time.Second,
		chromedp.WaitVisible(selector, chromedp.ByQuery),
		chromedp.Click(selector, chromedp.ByQuery),
		chromedp.Sleep(300*time.Millisecond),
	))
}

// CDP's query error otherwise gives the caller no way to recover from using
// a Playwright locator in the native CSS-only browser tools.
func selectorError(err error) error {
	if err != nil && strings.Contains(err.Error(), "DOM Error while querying") {
		return fmt.Errorf("%w; native browser tools require standard CSS selectors, not Playwright :has-text(), text=, or role= locators. Use a selector returned by browser_elements", err)
	}
	return err
}

func (b *Browser) Fill(ctx context.Context, selector, value string, submit bool) error {
	actions := []chromedp.Action{
		chromedp.WaitVisible(selector, chromedp.ByQuery),
		chromedp.Clear(selector, chromedp.ByQuery),
		chromedp.SendKeys(selector, value, chromedp.ByQuery),
	}
	// A successful key dispatch does not establish that the field accepted
	// the text (validation scripts, readonly inputs and re-renders can reject
	// it). Compare privately so credential values never enter error output.
	selJSON, _ := json.Marshal(selector)
	valueJSON, _ := json.Marshal(value)
	actions = append(actions, chromedp.ActionFunc(func(ctx context.Context) error {
		var matches bool
		expression := `(()=>{const el=document.querySelector(` + string(selJSON) + `);return !!el && (el.isContentEditable ? el.textContent : el.value) === ` + string(valueJSON) + `;})()`
		if err := chromedp.Evaluate(expression, &matches).Do(ctx); err != nil {
			return err
		}
		if !matches {
			return fmt.Errorf("field did not retain the requested value; inspect whether the application normalized, rejected, or replaced the input before retrying")
		}
		return nil
	}))
	if submit {
		actions = append(actions, chromedp.SendKeys(selector, "\r", chromedp.ByQuery))
	}
	actions = append(actions, chromedp.Sleep(300*time.Millisecond))
	return selectorError(b.run(ctx, 20*time.Second, actions...))
}

func (b *Browser) Eval(ctx context.Context, expr string) (string, error) {
	var raw json.RawMessage
	// Wrap so the caller can use a bare expression or a statement block.
	wrapped := "(() => { return (" + expr + "); })()"
	if err := b.run(ctx, 20*time.Second, chromedp.Evaluate(wrapped, &raw)); err != nil {
		// Retry treating it as a statement body.
		wrapped = "(() => { " + expr + " })()"
		if err2 := b.run(ctx, 20*time.Second, chromedp.Evaluate(wrapped, &raw)); err2 != nil {
			return "", err
		}
	}
	if len(raw) == 0 {
		return "undefined", nil
	}
	var pretty any
	if json.Unmarshal(raw, &pretty) == nil {
		if b, err := json.MarshalIndent(pretty, "", "  "); err == nil {
			return string(b), nil
		}
	}
	return string(raw), nil
}

func (b *Browser) WaitFor(ctx context.Context, selector string, timeoutMS int) error {
	if timeoutMS <= 0 {
		timeoutMS = 10000
	}
	return selectorError(b.run(ctx, time.Duration(timeoutMS)*time.Millisecond+2*time.Second,
		chromedp.WaitVisible(selector, chromedp.ByQuery)))
}

// Screenshot writes a PNG and returns its absolute path so the extension can
// show it inline in the chat panel.
func (b *Browser) Screenshot(ctx context.Context, selector string, fullPage bool) (string, error) {
	var buf []byte
	var action chromedp.Action
	switch {
	case selector != "":
		action = chromedp.Screenshot(selector, &buf, chromedp.NodeVisible, chromedp.ByQuery)
	case fullPage:
		action = chromedp.FullScreenshot(&buf, 85)
	default:
		action = chromedp.CaptureScreenshot(&buf)
	}
	if err := b.run(ctx, 30*time.Second, action); err != nil {
		return "", err
	}
	if err := os.MkdirAll(b.shotDir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("shot-%d.png", time.Now().UnixMilli())
	path := filepath.Join(b.shotDir, name)
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func (b *Browser) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Cancelling the context alone SIGKILLs Chromium, which loses any cookies
	// it has not yet flushed to the profile's SQLite store — so a persistent
	// profile would forget a login the moment the core exits. chromedp.Cancel
	// sends Browser.close and waits for a clean shutdown, which flushes. Only
	// worth it when there is a profile to preserve; give it a short deadline
	// so a wedged browser cannot hang teardown.
	if b.profileDir != "" && b.ctx != nil && b.ctx.Err() == nil {
		done := make(chan struct{})
		go func() {
			_ = chromedp.Cancel(b.ctx)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}

	if b.ctxCancel != nil {
		b.ctxCancel()
		b.ctxCancel = nil
	}
	if b.allocCancel != nil {
		b.allocCancel()
		b.allocCancel = nil
	}
	b.started = false
	b.ctx = nil
}

func (b *Browser) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.started && b.ctx != nil && b.ctx.Err() == nil
}
