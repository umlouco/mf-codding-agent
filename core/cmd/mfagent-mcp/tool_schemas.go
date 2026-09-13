package main

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

func statusEnum() []string {
	return []string{"PENDING", "EXECUTING", "VERIFYING", "VERIFIED", "PAUSED", "BLOCKED"}
}

func updateInputSchema() map[string]any {
	props := taskProperties()
	props["id"] = map[string]any{"type": "integer", "minimum": 1,
		"description": "Task id, as returned by task_queue_list or task_queue_create."}
	props["status"] = map[string]any{"type": "string", "enum": statusEnum(),
		"description": "Manually override the task's status."}
	props["seq"] = map[string]any{"type": "integer", "minimum": 1,
		"description": "1-based execution order. Prefer task_queue_reorder to resequence multiple tasks at once."}
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": props,
		"required":   []string{"id"},
	}
}

func updateOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"updated": map[string]any{"type": "boolean"}, "id": map[string]any{"type": "integer"},
		"task":   map[string]any{"type": "object", "additionalProperties": true},
		"issues": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	}, "required": []string{"updated"}}
}

func deleteInputSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"id": map[string]any{"type": "integer", "minimum": 1,
				"description": "Task id, as returned by task_queue_list."},
		},
		"required": []string{"id"},
	}
}

func deleteOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"deleted": map[string]any{"type": "boolean"}, "id": map[string]any{"type": "integer"},
		"issues": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	}, "required": []string{"deleted"}}
}

func reorderInputSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"ids": map[string]any{"type": "array", "minItems": 1,
				"items":       map[string]any{"type": "integer"},
				"description": "Every task id currently in the queue, in the desired execution order."},
		},
		"required": []string{"ids"},
	}
}

func reorderOutputSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{
		"reordered": map[string]any{"type": "boolean"}, "count": map[string]any{"type": "integer"},
	}, "required": []string{"reordered"}}
}

func taskProperties() map[string]any {
	return map[string]any{
		"title": map[string]any{"type": "string", "minLength": 3, "maxLength": 200,
			"description": "Short imperative title naming the outcome."},
		"description": map[string]any{"type": "string", "minLength": 20,
			"description": "Self-contained implementation instructions: scope, relevant files/components, constraints, and exact done state."},
		"behaviorCheck": map[string]any{"type": "string", "minLength": 10,
			"description": "The behavior the independent verification agent must establish by testing what the executor produced."},
		"maxAttempts": map[string]any{"type": "integer", "minimum": 1, "maximum": 20, "default": 3},
	}
}

func taskInputSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": taskProperties(),
		"required":   []string{"title", "description", "behaviorCheck"},
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
			"behaviorCheck": map[string]any{"type": "string"},
		}, "required": []string{"title", "description"}}
	return map[string]any{"type": "object", "additionalProperties": false,
		"properties": map[string]any{"tasks": map[string]any{"type": "array", "minItems": 1, "items": item}},
		"required":   []string{"tasks"}}
}

func toolAnnotations(title string, readOnly, destructive, idempotent bool) map[string]any {
	return map[string]any{"title": title, "readOnlyHint": readOnly,
		"destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": false}
}
