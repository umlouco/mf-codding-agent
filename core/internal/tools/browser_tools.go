package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mflores/mfagent/core/internal/browser"
)

func RegisterBrowser(r *Registry, b *browser.Browser) {
	if b == nil {
		return
	}

	formatState := func(st *browser.PageState) string {
		var sb strings.Builder
		fmt.Fprintf(&sb, "URL:   %s\nTitle: %s\n", st.URL, st.Title)
		var errs []string
		for _, l := range st.Console {
			if l.Level == "error" || l.Level == "exception" {
				errs = append(errs, l.Text)
			}
		}
		if len(errs) > 0 {
			sb.WriteString("\nConsole errors:\n")
			for _, e := range errs {
				fmt.Fprintf(&sb, "  ! %s\n", e)
			}
		}
		sb.WriteString("\nVisible text:\n")
		sb.WriteString(st.Text)
		return sb.String()
	}

	r.Add(&Tool{
		Name: "browser_open",
		Description: "Open a URL in a real Chromium instance and return the page URL, title, " +
			"visible text and any console errors. Use this to verify web changes actually " +
			"render and behave correctly, not just that the code compiles.",
		Mutating: true,
		Schema: obj(map[string]any{
			"url":      str("Absolute URL, e.g. http://localhost:5173/."),
			"wait_for": str("CSS selector to wait for before reading the page. Optional."),
		}, "url"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				URL string `json:"url"`
			}
			_ = json.Unmarshal(in, &a)
			return "Open " + a.URL + " in a browser"
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				URL     string `json:"url"`
				WaitFor string `json:"wait_for"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if !strings.Contains(a.URL, "://") {
				a.URL = "http://" + a.URL
			}
			st, err := b.Navigate(ctx, a.URL, a.WaitFor)
			if err != nil {
				return Errf("navigation failed: %v", err)
			}
			if env.Emit != nil {
				env.Emit("browser", map[string]any{"url": st.URL, "title": st.Title})
			}
			return Ok(formatState(st))
		},
	})

	r.Add(&Tool{
		Name: "browser_read",
		Description: "Re-read the current page: URL, title, visible text and console output. " +
			"Call after an interaction to see what changed.",
		Schema: obj(map[string]any{}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			st, err := b.State(ctx)
			if err != nil {
				return Errf("%v", err)
			}
			return Ok(formatState(st))
		},
	})

	r.Add(&Tool{
		Name: "browser_elements",
		Description: "List the interactive elements on the current page (links, buttons, inputs) " +
			"with a CSS selector for each. Call this before browser_click or browser_fill " +
			"instead of guessing selectors.",
		Schema: obj(map[string]any{}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			els, err := b.Interactive(ctx)
			if err != nil {
				return Errf("%v", err)
			}
			if len(els) == 0 {
				return Ok("No interactive elements found.")
			}
			var sb strings.Builder
			for _, e := range els {
				kind := e.Tag
				if e.Type != "" {
					kind += "[" + e.Type + "]"
				}
				state := ""
				if e.Disabled {
					state = " (disabled)"
				}
				fmt.Fprintf(&sb, "%-18s %-40q %s%s\n", kind, e.Label, e.Selector, state)
			}
			return Ok(sb.String())
		},
	})

	r.Add(&Tool{
		Name:        "browser_click",
		Description: "Click an element by CSS selector, then report the resulting page state.",
		// Not gated: the user already approved opening this page, and a prompt
		// per click would make browser testing unusable.
		Mutating: false,
		Schema: obj(map[string]any{
			"selector": str("CSS selector, ideally taken from browser_elements."),
		}, "selector"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Selector string `json:"selector"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			if err := b.Click(ctx, a.Selector); err != nil {
				return Errf("click %s: %v", a.Selector, err)
			}
			st, err := b.State(ctx)
			if err != nil {
				return Ok("Clicked " + a.Selector)
			}
			return Ok("Clicked " + a.Selector + "\n\n" + formatState(st))
		},
	})

	r.Add(&Tool{
		Name:        "browser_fill",
		Description: "Type a value into an input, textarea or contenteditable element.",
		Mutating:    false, // same reasoning as browser_click
		Schema: obj(map[string]any{
			"selector": str("CSS selector for the field."),
			"value":    str("Text to enter. Replaces any existing value."),
			"submit":   boolp("Press Enter afterwards. Default false."),
		}, "selector", "value"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Selector string `json:"selector"`
				Value    string `json:"value"`
				Submit   bool   `json:"submit"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			if err := b.Fill(ctx, a.Selector, a.Value, a.Submit); err != nil {
				return Errf("fill %s: %v", a.Selector, err)
			}
			return Ok(fmt.Sprintf("Filled %s.", a.Selector))
		},
	})

	r.Add(&Tool{
		Name: "browser_eval",
		Description: "Evaluate a JavaScript expression in the page and return the JSON result. " +
			"Use for assertions and for reading state the visible text does not expose, " +
			`e.g. "document.querySelectorAll('.row').length".`,
		Mutating: true, // arbitrary code execution in the page stays gated
		Schema: obj(map[string]any{
			"expression": str("JavaScript expression evaluated in the page context."),
		}, "expression"),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				Expression string `json:"expression"`
			}
			_ = json.Unmarshal(in, &a)
			return "Evaluate JavaScript in the page: " + a.Expression
		},
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Expression string `json:"expression"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			out, err := b.Eval(ctx, a.Expression)
			if err != nil {
				return Errf("evaluation failed: %v", err)
			}
			return Ok(out)
		},
	})

	r.Add(&Tool{
		Name:        "browser_wait",
		Description: "Wait until an element matching a CSS selector becomes visible.",
		Schema: obj(map[string]any{
			"selector":   str("CSS selector to wait for."),
			"timeout_ms": num("Timeout in milliseconds. Default 10000."),
		}, "selector"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Selector  string `json:"selector"`
				TimeoutMS int    `json:"timeout_ms"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			if err := b.WaitFor(ctx, a.Selector, a.TimeoutMS); err != nil {
				return Errf("%s did not become visible: %v", a.Selector, err)
			}
			return Ok(a.Selector + " is visible.")
		},
	})

	r.Add(&Tool{
		Name: "browser_screenshot",
		Description: "Capture a PNG of the current page or a single element. " +
			"The image is shown inline in the chat panel.",
		Schema: obj(map[string]any{
			"selector":  str("Capture only this element. Optional."),
			"full_page": boolp("Capture the full scrollable page. Default false."),
		}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Selector string `json:"selector"`
				FullPage bool   `json:"full_page"`
			}
			_ = json.Unmarshal(in, &a)
			if !b.Running() {
				return Errf("no browser session is open; call browser_open first")
			}
			path, err := b.Screenshot(ctx, a.Selector, a.FullPage)
			if err != nil {
				return Errf("screenshot failed: %v", err)
			}
			if env.Emit != nil {
				env.Emit("screenshot", map[string]any{"path": path})
			}
			return Result{
				Output: "Screenshot saved to " + env.Rel(path) +
					". It is displayed in the chat panel for the user.",
				Meta: map[string]any{"screenshot": path},
			}
		},
	})

	r.Add(&Tool{
		Name: "browser_console",
		Description: "Return everything the page logged to the console since the last navigation, " +
			"including uncaught exceptions.",
		Schema: obj(map[string]any{
			"errors_only": boolp("Return only errors and exceptions. Default false."),
		}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				ErrorsOnly bool `json:"errors_only"`
			}
			_ = json.Unmarshal(in, &a)
			logs := b.Logs(false)
			var sb strings.Builder
			for _, l := range logs {
				if a.ErrorsOnly && l.Level != "error" && l.Level != "exception" {
					continue
				}
				fmt.Fprintf(&sb, "[%s] %s\n", l.Level, l.Text)
			}
			if sb.Len() == 0 {
				return Ok("Console is clean.")
			}
			return Ok(sb.String())
		},
	})

	r.Add(&Tool{
		Name:        "browser_close",
		Description: "Shut down the browser session and free its resources.",
		Schema:      obj(map[string]any{}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			b.Close()
			return Ok("Browser closed.")
		},
	})
}
