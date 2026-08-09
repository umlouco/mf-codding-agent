package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mflores/mfagent/core/internal/memory"
)

// RegisterMemory exposes the graph store to the model as three tools that map
// onto the three memory tiers: remember (write), recall (hybrid retrieval),
// and trace (multi-hop traversal).
func RegisterMemory(r *Registry, store *memory.Store, sessionID func() string) {
	if store == nil {
		return
	}

	r.Add(&Tool{
		Name: "memory_remember",
		Description: "Persist durable knowledge about this codebase into the graph memory. " +
			"Record entities (files, symbols, modules, concepts, decisions, bugs), the typed " +
			"relations between them, and free-text observations. " +
			"Write here when you learn something that will still be true next session: an " +
			"architectural decision and its reason, a non-obvious dependency, a recurring bug " +
			"pattern, a convention the codebase follows. " +
			"Do NOT record what the code or git history already states plainly. " +
			"Valid entity kinds: " + nodeKindsDoc + ". Valid relations: " + relKindsDoc + ".",
		Schema: obj(map[string]any{
			"entities": map[string]any{
				"type":        "array",
				"description": "Entities to create or update.",
				"items": obj(map[string]any{
					"kind":    str("One of: " + nodeKindsDoc),
					"name":    str("Stable identifier, e.g. a file path or symbol name."),
					"summary": str("One or two sentences on what this is and why it matters."),
				}, "kind", "name"),
			},
			"relations": map[string]any{
				"type":        "array",
				"description": "Typed edges between entities. Both endpoints are created if missing.",
				"items": obj(map[string]any{
					"from_kind": str("Source entity kind."),
					"from_name": str("Source entity name."),
					"rel":       str("One of: " + relKindsDoc),
					"to_kind":   str("Target entity kind."),
					"to_name":   str("Target entity name."),
					"note":      str("Optional short note about the relation."),
				}, "from_name", "rel", "to_name"),
			},
			"observations": map[string]any{
				"type":        "array",
				"description": "Free-text facts attached to an entity.",
				"items": obj(map[string]any{
					"kind": str("Entity kind the observation belongs to."),
					"name": str("Entity name the observation belongs to."),
					"body": str("The fact. Include the reason, not just the conclusion."),
				}, "name", "body"),
			},
		}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Entities []struct {
					Kind    string `json:"kind"`
					Name    string `json:"name"`
					Summary string `json:"summary"`
				} `json:"entities"`
				Relations []struct {
					FromKind string `json:"from_kind"`
					FromName string `json:"from_name"`
					Rel      string `json:"rel"`
					ToKind   string `json:"to_kind"`
					ToName   string `json:"to_name"`
					Note     string `json:"note"`
				} `json:"relations"`
				Observations []struct {
					Kind string `json:"kind"`
					Name string `json:"name"`
					Body string `json:"body"`
				} `json:"observations"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}

			// Models routinely omit the kind on a relation endpoint. Defaulting
			// straight to "Concept" would fork a second node for an entity that
			// already exists as a File or Symbol, so resolve by name first.
			resolve := func(kind, name, summary string) (int64, string, error) {
				if kind == "" {
					if existing, err := store.FindNode("", name); err == nil {
						if summary != "" {
							if _, err := store.UpsertNode(existing.Kind, name, summary, nil); err != nil {
								return 0, "", err
							}
						}
						return existing.ID, existing.Kind, nil
					}
				}
				k := defaultKind(kind)
				n, err := store.UpsertNode(k, name, summary, nil)
				if err != nil {
					return 0, "", err
				}
				return n.ID, k, nil
			}

			var written []string
			// Entities first, so relations mentioning them resolve to the right
			// kind rather than inventing one.
			for _, e := range a.Entities {
				_, kind, err := resolve(e.Kind, e.Name, e.Summary)
				if err != nil {
					return Errf("storing entity %s: %v", e.Name, err)
				}
				written = append(written, fmt.Sprintf("%s(%s)", kind, e.Name))
			}
			for _, rl := range a.Relations {
				srcID, _, err := resolve(rl.FromKind, rl.FromName, "")
				if err != nil {
					return Errf("storing relation source %s: %v", rl.FromName, err)
				}
				dstID, _, err := resolve(rl.ToKind, rl.ToName, "")
				if err != nil {
					return Errf("storing relation target %s: %v", rl.ToName, err)
				}
				var props map[string]any
				if rl.Note != "" {
					props = map[string]any{"note": rl.Note}
				}
				if err := store.AddEdge(srcID, dstID, rl.Rel, 1.0, props); err != nil {
					return Errf("storing relation: %v", err)
				}
				written = append(written, fmt.Sprintf("%s -[%s]-> %s", rl.FromName, rl.Rel, rl.ToName))
			}
			sid := ""
			if sessionID != nil {
				sid = sessionID()
			}
			for _, o := range a.Observations {
				nodeID, _, err := resolve(o.Kind, o.Name, "")
				if err != nil {
					return Errf("storing observation target %s: %v", o.Name, err)
				}
				if _, err := store.AddObservation(nodeID, o.Body, "agent", sid); err != nil {
					return Errf("storing observation: %v", err)
				}
				written = append(written, fmt.Sprintf("obs on %s", o.Name))
			}
			if len(written) == 0 {
				return Errf("nothing to store: supply entities, relations or observations")
			}
			if env.Emit != nil {
				env.Emit("memory", map[string]any{"wrote": written})
			}
			return Ok("Stored: " + strings.Join(written, "; "))
		},
	})

	r.Add(&Tool{
		Name: "memory_recall",
		Description: "Search the graph memory. Runs full-text retrieval over entities and " +
			"observations, then expands one hop across the graph so related entities that " +
			"never mention your search terms are still surfaced. " +
			"Call this before starting non-trivial work in an area you may have touched before.",
		Schema: obj(map[string]any{
			"query":  str("What you are looking for, in natural language or as identifiers."),
			"limit":  num("Maximum entities to return. Default 8."),
			"expand": boolp("Include one-hop graph expansion. Default true."),
		}, "query"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Query  string `json:"query"`
				Limit  int    `json:"limit"`
				Expand *bool  `json:"expand"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			expand := a.Expand == nil || *a.Expand
			hits, err := store.Search(a.Query, a.Limit, expand)
			if err != nil {
				return Errf("recall failed: %v", err)
			}
			if len(hits) == 0 {
				return Ok("Nothing in memory matches that yet.")
			}
			var sb strings.Builder
			for i, h := range hits {
				fmt.Fprintf(&sb, "%d. [%s] %s  (score %.2f, %s)\n", i+1, h.Node.Kind, h.Node.Name, h.Score, h.Why)
				if h.Node.Summary != "" {
					fmt.Fprintf(&sb, "   %s\n", h.Node.Summary)
				}
				for _, o := range h.Obs {
					fmt.Fprintf(&sb, "   · %s\n", o.Body)
				}
				for _, n := range h.Neighbors {
					arrow := "->"
					if n.Direction == "in" {
						arrow = "<-"
					}
					fmt.Fprintf(&sb, "   %s %s %s [%s]\n", arrow, n.Rel, n.Node.Name, n.Node.Kind)
				}
			}
			if env.Emit != nil {
				env.Emit("memory", map[string]any{"recalled": len(hits), "query": a.Query})
			}
			return Ok(sb.String())
		},
	})

	r.Add(&Tool{
		Name: "memory_trace",
		Description: "Walk the memory graph outward from one entity, following typed relations " +
			"to an arbitrary depth. Use this for structural questions that a keyword search " +
			`cannot answer — "what depends on this module", "what did this decision supersede", ` +
			`"which endpoints reach this table".`,
		Schema: obj(map[string]any{
			"name":      str("Entity to start from."),
			"kind":      str("Entity kind, if the name alone is ambiguous."),
			"depth":     num("Hops to follow. Default 2, maximum 6."),
			"relations": map[string]any{"type": "array", "items": map[string]any{"type": "string"},
				"description": "Only follow these relation types. Omit to follow all."},
			"direction": str(`"out" (this entity -> others), "in" (others -> this), or "both". Default both.`),
			"limit":     num("Maximum entities to return. Default 40."),
		}, "name"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Name      string   `json:"name"`
				Kind      string   `json:"kind"`
				Depth     int      `json:"depth"`
				Relations []string `json:"relations"`
				Direction string   `json:"direction"`
				Limit     int      `json:"limit"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			seed, err := store.FindNode(a.Kind, a.Name)
			if err != nil {
				return Errf("no entity named %q in memory. Use memory_recall to find the right name.", a.Name)
			}
			steps, err := store.Traverse(seed.ID, a.Depth, a.Relations, a.Direction, a.Limit)
			if err != nil {
				return Errf("traversal failed: %v", err)
			}
			var sb strings.Builder
			fmt.Fprintf(&sb, "From [%s] %s:\n", seed.Kind, seed.Name)
			if seed.Summary != "" {
				fmt.Fprintf(&sb, "  %s\n", seed.Summary)
			}
			if len(steps) == 0 {
				sb.WriteString("  (no connected entities)\n")
			}
			for _, s := range steps {
				arrow := "->"
				if s.Direction == "in" {
					arrow = "<-"
				}
				fmt.Fprintf(&sb, "%s%s %s [%s] %s\n",
					strings.Repeat("  ", s.Depth), arrow, s.Rel, s.Node.Kind, s.Node.Name)
				if s.Node.Summary != "" {
					fmt.Fprintf(&sb, "%s   %s\n", strings.Repeat("  ", s.Depth), s.Node.Summary)
				}
			}
			return Ok(sb.String())
		},
	})

	// ---- reflection & abstraction (lessons) ---------------------------

	r.Add(&Tool{
		Name: "memory_reflect",
		Description: "Extract and persist a reusable lesson from completed work. After finishing " +
			"a verified task, reflect on what was learned that applies beyond this single task — " +
			"a pattern, a constraint, a non-obvious dependency, or a convention — and record it " +
			"as a structured lesson that future sessions will retrieve. " +
			"This is how the agent improves over time: retrieve → plan → execute → verify → reflect.",
		Schema: obj(map[string]any{
			"title":       str("Short imperative summary of the lesson, under 80 characters."),
			"description": str("One or two sentences explaining the lesson and when it applies."),
			"content": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": "2-4 concrete, actionable takeaways.",
			},
			"tags": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": "Keywords for retrieval, e.g. ['database', 'concurrency', 'testing'].",
			},
			"confidence": num("How sure you are this lesson generalises, 0.0–1.0. Default 0.7."),
			"source":     str("What entity or task produced this lesson, for traceability."),
		}, "title", "description"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Title       string   `json:"title"`
				Description string   `json:"description"`
				Content     []string `json:"content"`
				Tags        []string `json:"tags"`
				Confidence  float64  `json:"confidence"`
				Source      string   `json:"source"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.Title == "" {
				return Errf("title is required")
			}
			if a.Confidence <= 0 {
				a.Confidence = 0.7
			}
			lesson, err := store.UpsertLesson(a.Title, a.Description, a.Content, a.Tags, a.Confidence, a.Source)
			if err != nil {
				return Errf("storing lesson: %v", err)
			}
			return Ok(fmt.Sprintf("Lesson #%d stored: %s (confidence %.0f%%)",
				lesson.ID, lesson.Title, lesson.Confidence*100))
		},
	})

	r.Add(&Tool{
		Name: "memory_abstract",
		Description: "Find related lessons that may share a higher-level pattern, then " +
			"synthesise a parent abstraction. Call this when you notice several lessons " +
			"converging on the same underlying principle, e.g. three lessons about " +
			"concurrency could be abstracted into a single strategy lesson.",
		Schema: obj(map[string]any{
			"tags": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": "Find lessons matching any of these tags.",
			},
			"limit": num("Maximum lessons to return for synthesis. Default 10."),
		}, "tags"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Tags  []string `json:"tags"`
				Limit int      `json:"limit"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.Limit <= 0 {
				a.Limit = 10
			}
			lessons, err := store.FindSimilarLessons(a.Tags, a.Limit)
			if err != nil {
				return Errf("finding lessons: %v", err)
			}
			if len(lessons) == 0 {
				return Ok("No related lessons found with those tags.")
			}
			var sb strings.Builder
			sb.WriteString("Related lessons found:\n\n")
			for i, l := range lessons {
				fmt.Fprintf(&sb, "%d. [%d] %s (confidence %.0f%%, used %d×)\n",
					i+1, l.ID, l.Title, l.Confidence*100, l.UsageCount)
				if l.Description != "" {
					fmt.Fprintf(&sb, "   %s\n", l.Description)
				}
				for _, c := range l.Content {
					fmt.Fprintf(&sb, "   · %s\n", c)
				}
				if len(l.Tags) > 0 {
					fmt.Fprintf(&sb, "   tags: %s\n", strings.Join(l.Tags, ", "))
				}
				sb.WriteString("\n")
				store.RecordLessonUsage(l.ID)
			}
			sb.WriteString("Now run memory_reflect with a new title, description, and takeaways " +
				"that synthesise the pattern across these lessons.")
			return Ok(sb.String())
		},
	})
}

const nodeKindsDoc = memory.NodeKindsDoc
const relKindsDoc = memory.RelKindsDoc

func defaultKind(k string) string {
	k = strings.TrimSpace(k)
	if k == "" {
		return "Concept"
	}
	return strings.ToUpper(k[:1]) + k[1:]
}
