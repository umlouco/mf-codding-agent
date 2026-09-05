package playwright

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/mflores/mfagent/core/internal/layout"
)

//go:embed layout_capture.cjs
var layoutRunner string

type LayoutStep struct {
	Kind     string `json:"kind"`
	Selector string `json:"selector"`
	Value    string `json:"value,omitempty"`
}

// CaptureLayout provides a small declarative replay, without a generated test script
// or changing the project's configuration. Existing suites still use Run.
func CaptureLayout(ctx context.Context, setup *Setup, spec layout.Spec, target, executable, storageState string, steps []LayoutStep) (layout.Capture, error) {
	if err := spec.Validate(); err != nil {
		return layout.Capture{}, err
	}
	if setup.NodePath == "" || !setup.Installed {
		return layout.Capture{}, fmt.Errorf("Playwright capture requires node and the project's installed @playwright/test; call playwright_status")
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "file") {
		return layout.Capture{}, fmt.Errorf("provide an absolute http, https or file URL reachable from the workspace host")
	}
	if len(steps) > 12 {
		return layout.Capture{}, fmt.Errorf("at most 12 replay steps; split a longer flow")
	}
	for _, step := range steps {
		if step.Selector == "" || len(step.Selector) > 300 || len(step.Value) > 2000 {
			return layout.Capture{}, fmt.Errorf("invalid replay selector or value")
		}
		switch step.Kind {
		case "click", "fill", "select", "visible", "hidden":
		default:
			return layout.Capture{}, fmt.Errorf("step kind must be click, fill, select, visible or hidden")
		}
	}
	temp, err := os.MkdirTemp("", "mfagent-layout-")
	if err != nil {
		return layout.Capture{}, err
	}
	defer os.RemoveAll(temp)
	runner := filepath.Join(temp, "capture.cjs")
	if err = os.WriteFile(runner, []byte(layoutRunner), 0600); err != nil {
		return layout.Capture{}, err
	}
	request := map[string]any{"root": setup.Root, "spec": spec, "url": target, "executable": executable, "storageState": storageState, "steps": steps, "selectors": spec.Selectors(), "measure": layout.MeasureJS, "output": temp}
	if steps == nil {
		request["steps"] = []LayoutStep{}
	}
	data, _ := json.Marshal(request)
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(runCtx, setup.NodePath, runner)
	configureCommand(cmd)
	cmd.Dir = setup.Root
	cmd.Stdin = bytes.NewReader(data)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return layout.Capture{}, fmt.Errorf("Playwright capture failed: %w: %s", err, tail(string(out), 2000))
	}
	data, err = os.ReadFile(filepath.Join(temp, "capture.json"))
	if err != nil {
		return layout.Capture{}, err
	}
	var capture layout.Capture
	if err = json.Unmarshal(data, &capture); err != nil {
		return capture, err
	}
	capture.PNG, err = os.ReadFile(filepath.Join(temp, "capture.png"))
	return capture, err
}
