package main

import (
	"context"
	"encoding/json"
	"fmt"
)

// ---- memory ------------------------------------------------------------

func (s *server) onMemoryStats(ctx context.Context, _ json.RawMessage) (any, error) {
	if s.mem == nil {
		return map[string]any{"enabled": false}, nil
	}
	return s.mem.Stats()
}

func (s *server) onMemoryGraph(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return map[string]any{"nodes": []any{}, "edges": []any{}}, nil
	}
	var a struct {
		Limit int `json:"limit"`
	}
	_ = json.Unmarshal(params, &a)
	return s.mem.GraphView(a.Limit)
}

func (s *server) onMemorySearch(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return []any{}, nil
	}
	var a struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	return s.mem.Search(a.Query, a.Limit, true)
}

func (s *server) onMemoryForget(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return map[string]any{"removed": 0}, nil
	}
	var a struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	n, err := s.mem.Forget(a.Kind, a.Name)
	if err != nil {
		return nil, err
	}
	return map[string]any{"removed": n}, nil
}

func (s *server) onMemoryLessons(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return []any{}, nil
	}
	var a struct {
		Tags  []string `json:"tags"`
		Limit int      `json:"limit"`
	}
	_ = json.Unmarshal(params, &a)
	return s.mem.Lessons(a.Tags, a.Limit)
}

func (s *server) onMemoryLessonUpsert(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return nil, fmt.Errorf("memory is not enabled")
	}
	var a struct {
		Title       string   `json:"title"`
		Description string   `json:"description"`
		Content     []string `json:"content"`
		Tags        []string `json:"tags"`
		Confidence  float64  `json:"confidence"`
		Source      string   `json:"source"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	return s.mem.UpsertLesson(a.Title, a.Description, a.Content, a.Tags, a.Confidence, a.Source)
}

func (s *server) onMemoryLessonDelete(ctx context.Context, params json.RawMessage) (any, error) {
	if s.mem == nil {
		return nil, fmt.Errorf("memory is not enabled")
	}
	var a struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(params, &a); err != nil {
		return nil, err
	}
	if err := s.mem.DeleteLesson(a.ID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func (s *server) onMCPStatus(ctx context.Context, _ json.RawMessage) (any, error) {
	return s.mcpMgr.Status(), nil
}

func (s *server) onBrowserClose(ctx context.Context, _ json.RawMessage) (any, error) {
	if s.brw != nil {
		s.brw.Close()
	}
	return map[string]any{"ok": true}, nil
}
