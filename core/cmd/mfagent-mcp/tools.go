package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mflores/mfagent/core/internal/queue"
)

const planGuidance = "Tasks must be ordered, independently executable, and self-contained. " +
	"Descriptions should name the relevant files/components and exact outcome. Every task must " +
	"include separate implementation and behavior checks; add a verification command whenever " +
	"the repository has a deterministic build, lint, or test command."

func (s *server) registerTools() {
	s.tools = []registeredTool{
		{
			Name: "task_queue_write_plan",
			Description: "Create a high-quality ordered task list in one atomic operation. " + planGuidance +
				" Use mode=replace for a new plan or mode=append to extend the existing queue. " +
				" Set dryRun=true to validate without writing.",
			InputSchema:  planInputSchema(),
			OutputSchema: planOutputSchema(),
			Annotations:  toolAnnotations("Write task plan", false, true, true),
			Handler:      s.onWritePlan,
		},
		{
			Name: "task_queue_create",
			Description: "Append one fully specified, independently verifiable task. Prefer " +
				"task_queue_write_plan when creating more than one task.",
			InputSchema:  taskInputSchema(),
			OutputSchema: createOutputSchema(),
			Annotations:  toolAnnotations("Append task", false, false, false),
			Handler:      s.onCreate,
		},
		{
			Name:         "task_queue_list",
			Description:  "Read the complete ordered task list, including verification criteria, status, executor validation, and supervisor feedback.",
			InputSchema:  emptySchema(),
			OutputSchema: listOutputSchema(),
			Annotations:  toolAnnotations("List task queue", true, false, true),
			Handler:      s.onList,
		},
		{
			Name:         "task_queue_stats",
			Description:  "Read queue status counts, aggregate token usage, and autonomous run state.",
			InputSchema:  emptySchema(),
			OutputSchema: statsOutputSchema(),
			Annotations:  toolAnnotations("Task queue statistics", true, false, true),
			Handler:      s.onStats,
		},
		{
			Name: "task_queue_generate",
			Description: "Compatibility alias that replaces the queue. For better validation, " +
				"dry-run support, append mode, and goal storage, use task_queue_write_plan.",
			InputSchema:  legacyPlanSchema(),
			OutputSchema: legacyOutputSchema(),
			Annotations:  toolAnnotations("Replace task queue (legacy)", false, true, true),
			Handler:      s.onGenerate,
		},
	}
}

func emptySchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{}}
}

func planOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"valid": map[string]any{"type": "boolean"}, "written": map[string]any{"type": "boolean"},
		"dryRun": map[string]any{"type": "boolean"}, "mode": map[string]any{"type": "string"},
		"count": map[string]any{"type": "integer"}, "goal": map[string]any{"type": "string"},
		"issues": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	}, "required": []string{"valid"}}
}

func createOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"created": map[string]any{"type": "boolean"}, "id": map[string]any{"type": "integer"},
		"title":  map[string]any{"type": "string"},
		"issues": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	}, "required": []string{"created"}}
}

func listOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"count": map[string]any{"type": "integer"},
		"tasks": map[string]any{"type": "array", "items": map[string]any{
			"type": "object", "additionalProperties": true}},
	}, "required": []string{"count", "tasks"}}
}

func statsOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"total": map[string]any{"type": "integer"}, "byStatus": map[string]any{"type": "object"},
		"runState": map[string]any{"type": "string"}, "usage": map[string]any{"type": "object"},
	}, "required": []string{"total", "byStatus", "runState", "usage"}}
}

func legacyOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"replaced": map[string]any{"type": "boolean"}, "count": map[string]any{"type": "integer"},
		"issues": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	}, "required": []string{"replaced"}}
}

func taskProperties() map[string]any {
	return map[string]any{
		"title": map[string]any{"type": "string", "minLength": 3, "maxLength": 200,
			"description": "Short imperative title naming the outcome."},
		"description": map[string]any{"type": "string", "minLength": 20,
			"description": "Self-contained implementation instructions: scope, relevant files/components, constraints, and exact done state."},
		"implementationCheck": map[string]any{"type": "string", "minLength": 10,
			"description": "How the executor proves the requested code/files/configuration exist and are coherent."},
		"behaviorCheck": map[string]any{"type": "string", "minLength": 10,
			"description": "How the executor proves observable behavior and regression safety."},
		"verificationCommand": map[string]any{"type": "string",
			"description": "Optional repository-root shell command that deterministically builds/tests this task and exits 0 on success."},
		"maxAttempts": map[string]any{"type": "integer", "minimum": 1, "maximum": 20, "default": 3},
	}
}

func taskInputSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": taskProperties(),
		"required":   []string{"title", "description", "implementationCheck", "behaviorCheck"},
	}
}

func planInputSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"goal": map[string]any{"type": "string", "minLength": 5,
				"description": "The overall user goal this ordered plan accomplishes."},
			"mode": map[string]any{"type": "string", "enum": []string{"replace", "append"}, "default": "replace"},
			"dryRun": map[string]any{"type": "boolean", "default": false,
				"description": "Validate and summarize the plan without changing the database."},
			"tasks": map[string]any{"type": "array", "minItems": 1, "maxItems": 100,
				"description": "Tasks in dependency order; earlier tasks must establish prerequisites for later tasks.",
				"items":       taskInputSchema()},
		},
		"required": []string{"goal", "tasks"},
	}
}

func legacyPlanSchema() map[string]any {
	item := map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"title": map[string]any{"type": "string"}, "description": map[string]any{"type": "string"},
			"implementationCheck": map[string]any{"type": "string"}, "behaviorCheck": map[string]any{"type": "string"},
			"verificationCommand": map[string]any{"type": "string"},
		}, "required": []string{"title", "description"}}
	return map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{"tasks": map[string]any{"type": "array", "minItems": 1, "items": item}},
		"required":   []string{"tasks"}}
}

func toolAnnotations(title string, readOnly, destructive, idempotent bool) map[string]any {
	return map[string]any{"title": title, "readOnlyHint": readOnly,
		"destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": false}
}

type taskArgs struct {
	Title               string `json:"title"`
	Description         string `json:"description"`
	ImplementationCheck string `json:"implementationCheck"`
	BehaviorCheck       string `json:"behaviorCheck"`
	VerificationCommand string `json:"verificationCommand"`
	MaxAttempts         int    `json:"maxAttempts"`
}

func (t taskArgs) queueTask() queue.NewTask {
	return queue.NewTask{Title: strings.TrimSpace(t.Title), Description: strings.TrimSpace(t.Description),
		ImplVerifyPrompt:      strings.TrimSpace(t.ImplementationCheck),
		SolutionVerifyPrompt:  strings.TrimSpace(t.BehaviorCheck),
		SolutionVerifyCommand: strings.TrimSpace(t.VerificationCommand), MaxAttempts: t.MaxAttempts}
}

func validateTasks(tasks []taskArgs, strict bool) ([]queue.NewTask, []string) {
	out := make([]queue.NewTask, 0, len(tasks))
	var issues []string
	seen := map[string]bool{}
	for i, raw := range tasks {
		t := raw.queueTask()
		prefix := fmt.Sprintf("task %d", i+1)
		if len(t.Title) < 3 {
			issues = append(issues, prefix+": title must be at least 3 characters")
		}
		if len(t.Title) > 200 {
			issues = append(issues, prefix+": title must be at most 200 characters")
		}
		if len(t.Description) < 20 {
			issues = append(issues, prefix+": description must be self-contained (at least 20 characters)")
		}
		key := strings.ToLower(t.Title)
		if seen[key] {
			issues = append(issues, prefix+": duplicate title "+t.Title)
		}
		seen[key] = true
		if strict && len(t.ImplVerifyPrompt) < 10 {
			issues = append(issues, prefix+": implementationCheck is required")
		}
		if strict && len(t.SolutionVerifyPrompt) < 10 {
			issues = append(issues, prefix+": behaviorCheck is required")
		}
		if raw.MaxAttempts < 0 || raw.MaxAttempts > 20 {
			issues = append(issues, prefix+": maxAttempts must be between 1 and 20 when provided")
		}
		out = append(out, t)
	}
	return out, issues
}

func (s *server) onWritePlan(_ context.Context, params json.RawMessage) (string, bool, error) {
	var in struct {
		Goal   string     `json:"goal"`
		Mode   string     `json:"mode"`
		DryRun bool       `json:"dryRun"`
		Tasks  []taskArgs `json:"tasks"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return "", true, fmt.Errorf("invalid arguments: %w", err)
	}
	in.Goal = strings.TrimSpace(in.Goal)
	if len(in.Goal) < 5 {
		return "", true, fmt.Errorf("goal must be at least 5 characters")
	}
	if in.Mode == "" {
		in.Mode = "replace"
	}
	if in.Mode != "replace" && in.Mode != "append" {
		return "", true, fmt.Errorf("mode must be replace or append")
	}
	tasks, issues := validateTasks(in.Tasks, true)
	if len(tasks) == 0 {
		issues = append(issues, "plan must contain at least one task")
	}
	if len(tasks) > 100 {
		issues = append(issues, "plan may contain at most 100 tasks")
	}
	if len(issues) > 0 {
		return jsonText(map[string]any{"valid": false, "issues": issues}), true, nil
	}
	result := map[string]any{"valid": true, "dryRun": in.DryRun, "mode": in.Mode, "count": len(tasks), "goal": in.Goal}
	if in.DryRun {
		return jsonText(result), false, nil
	}
	if err := queue.WritePlan(s.db, tasks, in.Goal, in.Mode == "replace"); err != nil {
		return "", true, err
	}
	result["written"] = true
	return jsonText(result), false, nil
}

func (s *server) onCreate(_ context.Context, params json.RawMessage) (string, bool, error) {
	var in taskArgs
	if err := json.Unmarshal(params, &in); err != nil {
		return "", true, fmt.Errorf("invalid arguments: %w", err)
	}
	tasks, issues := validateTasks([]taskArgs{in}, true)
	if len(issues) > 0 {
		return jsonText(map[string]any{"created": false, "issues": issues}), true, nil
	}
	t := tasks[0]
	attempts := t.MaxAttempts
	if attempts <= 0 {
		attempts = 3
	}
	id, err := queue.CreateTask(s.db, t.Title, t.Description, queue.WithImplVerifyPrompt(t.ImplVerifyPrompt),
		queue.WithSolutionVerifyPrompt(t.SolutionVerifyPrompt), queue.WithSolutionVerifyCommand(t.SolutionVerifyCommand),
		queue.WithMaxAttempts(attempts))
	if err != nil {
		return "", true, fmt.Errorf("create failed: %w", err)
	}
	return jsonText(map[string]any{"created": true, "id": id, "title": t.Title}), false, nil
}

func (s *server) onList(_ context.Context, _ json.RawMessage) (string, bool, error) {
	tasks, err := queue.ListTasks(s.db)
	if err != nil {
		return "", true, fmt.Errorf("list failed: %w", err)
	}
	if tasks == nil {
		tasks = []queue.Task{}
	}
	return jsonText(map[string]any{"tasks": tasks, "count": len(tasks)}), false, nil
}

func (s *server) onStats(_ context.Context, _ json.RawMessage) (string, bool, error) {
	stats, err := queue.Stats(s.db)
	if err != nil {
		return "", true, fmt.Errorf("stats failed: %w", err)
	}
	return jsonText(stats), false, nil
}

func (s *server) onGenerate(_ context.Context, params json.RawMessage) (string, bool, error) {
	var in struct {
		Tasks []taskArgs `json:"tasks"`
	}
	if err := json.Unmarshal(params, &in); err != nil {
		return "", true, fmt.Errorf("invalid arguments: %w", err)
	}
	tasks, issues := validateTasks(in.Tasks, false)
	if len(tasks) == 0 {
		issues = append(issues, "tasks array must not be empty")
	}
	if len(issues) > 0 {
		return jsonText(map[string]any{"replaced": false, "issues": issues}), true, nil
	}
	if err := queue.ReplaceAll(s.db, tasks); err != nil {
		return "", true, fmt.Errorf("generate failed: %w", err)
	}
	return jsonText(map[string]any{"replaced": true, "count": len(tasks)}), false, nil
}

func jsonText(value any) string { out, _ := json.Marshal(value); return string(out) }
