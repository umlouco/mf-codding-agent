package tools

import (
	"context"
	"encoding/json"
	"path/filepath"

	"github.com/mflores/mfagent/core/internal/browser"
	"github.com/mflores/mfagent/core/internal/layout"
	"github.com/mflores/mfagent/core/internal/llm"
	"github.com/mflores/mfagent/core/internal/playwright"
)

func RegisterLayout(r *Registry, b *browser.Browser, vision llm.Provider) {
	criteria := map[string]any{"type": "array", "minItems": 1, "maxItems": 8, "items": obj(map[string]any{
		"id": str("Short unique criterion ID."), "requirement": str("One observable visual requirement; not a behavior or vague request to look good."),
		"selectors": map[string]any{"type": "array", "minItems": 1, "maxItems": 3, "items": str("Concrete CSS selector from browser_elements or inspected source.")},
	}, "id", "requirement", "selectors")}
	for _, engine := range []string{"browser", "playwright"} {
		engine := engine
		properties := map[string]any{"criteria": criteria, "width": num("Viewport width in CSS pixels, default 1280."), "height": num("Viewport height, default 800.")}
		required := []string{"criteria"}
		description := "Capture the current browser state and ask the configured Vision model to inspect 1..8 explicit layout requirements. Returns text findings and saved PNG/DOM evidence. Use after browser interactions. PASS covers only visual criteria in this viewport; still run behavioral checks. INCOMPLETE means do not claim success."
		if engine == "playwright" {
			description = "Replay a short browser flow using the project's installed Playwright, then ask Vision to inspect its captured layout. Runs headless on the workspace host, including SSH Linux. No generated spec or project config is needed. Independent from the browser_* session. Run playwright_test separately for the project's suite."
			properties["url"] = str("Absolute URL reachable from the workspace host, not the local laptop when using SSH.")
			properties["storage_state"] = str("Optional workspace-relative existing Playwright storageState JSON for authentication. Never written by this tool.")
			properties["steps"] = map[string]any{"type": "array", "maxItems": 12, "items": obj(map[string]any{"kind": map[string]any{"type": "string", "enum": []string{"click", "fill", "select", "visible", "hidden"}}, "selector": str("CSS selector."), "value": str("Value for fill or select.")}, "kind", "selector")}
			required = append(required, "url")
		}
		r.Add(&Tool{Name: engine + "_layout_check", Description: description, Mutating: true, Schema: obj(properties, required...), Run: func(ctx context.Context, env *Env, input json.RawMessage) Result {
			var args struct {
				layout.Spec
				URL          string                  `json:"url"`
				StorageState string                  `json:"storage_state"`
				Steps        []playwright.LayoutStep `json:"steps"`
			}
			if err := json.Unmarshal(input, &args); err != nil {
				return Errf("invalid layout request: %v", err)
			}
			if err := args.Spec.Validate(); err != nil {
				return Errf("%v", err)
			}
			var capture layout.Capture
			var err error
			if engine == "browser" {
				if b == nil || !b.Running() {
					return Errf("call browser_open and reach the required state first")
				}
				capture, err = b.CaptureLayout(ctx, args.Spec)
			} else {
				state := ""
				if args.StorageState != "" {
					state, err = env.Resolve(args.StorageState)
					if err != nil {
						return Errf("storage state: %v", err)
					}
				}
				capture, err = playwright.CaptureLayout(ctx, playwright.Detect(env.Root), args.Spec, args.URL, "", state, args.Steps)
			}
			if err != nil {
				return Errf("layout capture incomplete: %v", err)
			}
			report, err := layout.Review(ctx, env.Root, args.Spec, capture, vision)
			if err != nil {
				return Errf("layout review incomplete: %v", err)
			}
			if env.Emit != nil {
				env.Emit("screenshot", map[string]any{"path": filepath.Join(filepath.Dir(report.Artifact), "screenshot.png")})
			}
			report.Artifact = env.Rel(report.Artifact)
			data, _ := json.Marshal(report)
			return Result{Output: string(data), Usage: report.Usage}
		}})
	}
}
