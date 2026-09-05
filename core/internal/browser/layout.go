package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/mflores/mfagent/core/internal/layout"
)

// CaptureLayout samples the same isolated browser used by the interaction tools.
// It does not reload, log in, or run model-generated JavaScript.
func (b *Browser) CaptureLayout(ctx context.Context, spec layout.Spec) (layout.Capture, error) {
	if err := spec.Validate(); err != nil {
		return layout.Capture{}, err
	}
	selectors, _ := json.Marshal(spec.Selectors())
	expression := "(" + layout.MeasureJS + ")(" + string(selectors) + ")"
	var before, after json.RawMessage
	var first, second []byte
	err := b.run(ctx, 30*time.Second,
		chromedp.EmulateViewport(int64(spec.Width), int64(spec.Height)),
		chromedp.Sleep(250*time.Millisecond),
		chromedp.Evaluate(expression, &before),
		chromedp.CaptureScreenshot(&first),
		chromedp.Sleep(200*time.Millisecond),
		chromedp.CaptureScreenshot(&second),
		chromedp.Evaluate(expression, &after),
	)
	if err != nil {
		return layout.Capture{}, err
	}
	var state struct {
		FontsReady bool `json:"fontsReady"`
	}
	_ = json.Unmarshal(after, &state)
	return layout.Capture{PNG: second, DOM: after, Stable: state.FontsReady && bytes.Equal(before, after) && bytes.Equal(first, second), Engine: "chromedp"}, nil
}
