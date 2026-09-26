package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// run_script is code-as-action: one model turn carries a whole ordered batch of
// tool calls, so the many small file reads, edits and commands that would each
// have needed their own round-trip happen inside a single response.
//
// The measured problem this addresses is round-trip count, not tool latency: a
// Pac-Man run made ~467 model calls while every tool call it produced finished
// in under a second. Batching collapses the call-per-turn shape without adding
// a runtime or a sandbox to maintain.
//
// It is deliberately not a scripting language. A step is a registered tool and
// its arguments, and an earlier step's output can be referenced as ${name} in a
// later step's arguments with "save". That is enough data flow for read→edit
// sequences while keeping every action inside a tool the core already audits,
// validates and confines.
//
// Safety is inherited, not bypassed: each step calls the same Tool.Run a
// single call would, so path confinement, destructive-command refusal, testing
// and queue guards, and every other per-tool check still apply. The batch only
// adds sequencing, an output budget, and a ban on recursion. It has no wall
// clock of its own: every step keeps its own tool timeout, exactly as it would
// as a direct call, so a batch on a slow machine is not cut short where the
// same calls made one by one would not be.

const (
	batchMaxSteps       = 25
	batchStepOutputCap  = 8000
	batchTotalOutputCap = 60000
)

type batchStep struct {
	Tool string          `json:"tool"`
	Args json.RawMessage `json:"args"`
	Save string          `json:"save"`
	Note string          `json:"note"`
}

func parseBatchSteps(in json.RawMessage) ([]batchStep, error) {
	var args struct {
		Steps []batchStep `json:"steps"`
	}
	if err := json.Unmarshal(in, &args); err != nil {
		return nil, err
	}
	return args.Steps, nil
}

// substituteVars replaces ${name} in every string of a decoded argument value
// with the saved output of an earlier step. Substitution happens on decoded
// strings, not on raw JSON, so a value saved from one step cannot escape its
// string position and change the shape of the next step's arguments.
func substituteVars(value any, vars map[string]string) any {
	switch typed := value.(type) {
	case string:
		if len(vars) == 0 {
			return typed
		}
		out := typed
		for name, val := range vars {
			out = strings.ReplaceAll(out, "${"+name+"}", val)
		}
		return out
	case map[string]any:
		for k, v := range typed {
			typed[k] = substituteVars(v, vars)
		}
		return typed
	case []any:
		for i, v := range typed {
			typed[i] = substituteVars(v, vars)
		}
		return typed
	default:
		return value
	}
}

func stepArgs(step batchStep, vars map[string]string) (json.RawMessage, error) {
	if len(step.Args) == 0 || string(step.Args) == "null" {
		return json.RawMessage(`{}`), nil
	}
	var decoded any
	if err := json.Unmarshal(step.Args, &decoded); err != nil {
		return nil, fmt.Errorf("step %q has invalid args: %w", step.Tool, err)
	}
	encoded, err := json.Marshal(substituteVars(decoded, vars))
	if err != nil {
		return nil, err
	}
	return json.RawMessage(encoded), nil
}

// RegisterBatch adds run_script. It is registered over the same registry it
// reads, so it can batch every tool the core has — the FS and shell tools, the
// browser tools, and the MCP and editor tools registered later — without a
// fixed list to keep in sync.
func RegisterBatch(r *Registry) {
	r.Add(&Tool{
		Name: "run_script",
		Description: "Run several tool calls in one turn, in order. Each step names a registered " +
			"tool and its arguments, so a read→edit→command sequence costs one round-trip instead " +
			"of one per call. An earlier step's output can be reused by saving it with \"save\" and " +
			"referencing \"${name}\" in a later step's arguments. Steps run sequentially and stop at " +
			"the first failure unless stop_on_error is false. Every step is checked exactly as a " +
			"normal call would be — path confinement, destructive-command refusal and the testing " +
			"and queue guards all still apply. Use this to collapse many small operations into one " +
			"turn; use a single tool call when only one operation is needed. run_script cannot " +
			"contain another run_script.",
		Mutating: true,
		MutatesOn: func(in json.RawMessage) bool {
			steps, err := parseBatchSteps(in)
			if err != nil {
				return true // unparseable: sequence it rather than race it
			}
			for _, step := range steps {
				child, ok := r.Get(step.Tool)
				if !ok {
					return true // unknown tool: assume it mutates
				}
				if child.Mutates(step.Args) {
					return true
				}
			}
			return false
		},
		Summarize: func(in json.RawMessage) string {
			steps, err := parseBatchSteps(in)
			if err != nil || len(steps) == 0 {
				return "Run a batch of tool calls"
			}
			names := make([]string, 0, len(steps))
			for _, step := range steps {
				names = append(names, step.Tool)
			}
			return fmt.Sprintf("Run %d steps: %s", len(steps), strings.Join(names, ", "))
		},
		Schema: obj(map[string]any{
			"steps": map[string]any{
				"type":        "array",
				"description": "Ordered tool calls to run in this turn.",
				"items": obj(map[string]any{
					"tool": str("Name of a registered tool to call."),
					"args": map[string]any{
						"type":        "object",
						"description": "Arguments for that tool, matching its own schema.",
						"properties":  map[string]any{},
					},
					"save": str("Optional variable name for this step's output; later steps may use ${name}."),
					"note": str("Optional short reason this step is needed, shown while it runs."),
				}, "tool"),
			},
			"stop_on_error": boolp("Stop at the first failing step. Default true; set false to run independent steps anyway."),
		}, "steps"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var args struct {
				Steps       []batchStep `json:"steps"`
				StopOnError *bool       `json:"stop_on_error"`
			}
			if err := json.Unmarshal(in, &args); err != nil {
				return Errf("bad input: %v", err)
			}
			if len(args.Steps) == 0 {
				return Errf("run_script needs at least one step")
			}
			if len(args.Steps) > batchMaxSteps {
				return Errf("run_script accepts at most %d steps, got %d", batchMaxSteps, len(args.Steps))
			}

			stopOnError := true
			if args.StopOnError != nil {
				stopOnError = *args.StopOnError
			}

			vars := map[string]string{}
			var report strings.Builder
			failures := 0
			ran := 0
			stopped := ""

			for i, step := range args.Steps {
				if err := ctx.Err(); err != nil {
					stopped = fmt.Sprintf("stopped before step %d: the turn was cancelled", i+1)
					break
				}
				name := strings.TrimSpace(step.Tool)
				header := fmt.Sprintf("[%d] %s", i+1, name)
				if step.Note != "" {
					header += " — " + step.Note
				}
				if name == "" {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: no tool name\n\n", header)
					if stopOnError {
						stopped = "stopped after a step with no tool name"
						break
					}
					continue
				}
				// Recursion would make one turn an unbounded program and defeat
				// the round-trip budget; a script that wants a script should say so.
				if name == "run_script" {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: run_script cannot contain another run_script\n\n", header)
					if stopOnError {
						stopped = "stopped at a nested run_script"
						break
					}
					continue
				}
				child, ok := r.Get(name)
				if !ok {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: unknown tool %q\n\n", header, name)
					if stopOnError {
						stopped = fmt.Sprintf("stopped at unknown tool %q", name)
						break
					}
					continue
				}

				stepInput, err := stepArgs(step, vars)
				if err != nil {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: %v\n\n", header, err)
					if stopOnError {
						stopped = "stopped at invalid step arguments"
						break
					}
					continue
				}

				// Each step passes the same gates a direct call would, so a
				// batch cannot reach a tool the current role or an
				// inspection-only review forbids. Without this, run_script would
				// be a way around a restriction the definitions only advertise.
				childMutating := child.Mutates(stepInput)
				if !QueueToolAllowed(env.QueueRole, name) {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: queue ownership: %s is not available to the %s role\n\n", header, name, env.QueueRole)
					if stopOnError {
						stopped = fmt.Sprintf("stopped after %q was refused", name)
						break
					}
					continue
				}
				if err := env.CheckQueueOwnership(name, stepInput, childMutating); err != nil {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: %v\n\n", header, err)
					if stopOnError {
						stopped = fmt.Sprintf("stopped after %q was refused", name)
						break
					}
					continue
				}
				if err := env.CheckTestingTool(name, stepInput); err != nil {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: testing environment: %v\n\n", header, err)
					if stopOnError {
						stopped = fmt.Sprintf("stopped after %q was refused", name)
						break
					}
					continue
				}
				if env.InspectOnly && (childMutating || child.MutatesOn != nil) {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED: %s is unavailable during this live inspection-only review\n\n", header, name)
					if stopOnError {
						stopped = fmt.Sprintf("stopped after %q was refused", name)
						break
					}
					continue
				}

				res := child.Run(ctx, env, stepInput)
				ran++
				if !res.IsError {
					// A direct call records this after a successful run (see
					// agent.executeTool); without it a batched browser_open of
					// the testing URL never counted as having opened it.
					env.ObserveTestingTool(name, stepInput)
				}
				if step.Save != "" && res.Output != "" {
					vars[step.Save] = res.Output
				}
				body := clamp(strings.TrimRight(res.Output, "\r\n"), batchStepOutputCap)
				if strings.TrimSpace(body) == "" {
					body = "(no output)"
				}
				if res.IsError {
					failures++
					fmt.Fprintf(&report, "%s\nFAILED:\n%s\n\n", header, body)
					if stopOnError {
						stopped = fmt.Sprintf("stopped after %q failed", name)
						break
					}
					continue
				}
				fmt.Fprintf(&report, "%s\nok:\n%s\n\n", header, body)
			}

			summary := fmt.Sprintf("run_script: %d step(s) requested, %d run, %d failed", len(args.Steps), ran, failures)
			if stopped != "" {
				summary += "\n" + stopped
			}
			out := summary + "\n\n" + strings.TrimRight(report.String(), "\n")
			return Result{
				Output:  clamp(out, batchTotalOutputCap),
				IsError: failures > 0 || stopped != "",
				Meta:    map[string]any{"steps": len(args.Steps), "ran": ran, "failed": failures},
			}
		},
	})
}
