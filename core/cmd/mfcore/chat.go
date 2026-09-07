package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mflores/mfagent/core/internal/agent"
)

// ---- chat --------------------------------------------------------------

func (s *server) onSend(ctx context.Context, params json.RawMessage) (any, error) {
	if s.ag == nil {
		return nil, fmt.Errorf("core is not initialized")
	}
	var req agent.SendRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	if req.SessionID == "" {
		req.SessionID = "default"
	}

	s.sessionMu.Lock()
	s.curSess = req.SessionID
	s.sessionMu.Unlock()

	cctx, cancel := context.WithCancel(context.Background())
	s.conn.TrackCancel(req.SessionID, cancel)
	defer func() {
		s.conn.ClearCancel(req.SessionID)
		cancel()
	}()

	res, err := s.ag.Send(cctx, req)
	if err != nil {
		if cctx.Err() != nil {
			_ = s.conn.Notify("stream/done", map[string]any{
				"sessionId": req.SessionID, "stopReason": "cancelled",
			})
			return map[string]any{"sessionId": req.SessionID, "stopReason": "cancelled"}, nil
		}
		_ = s.conn.Notify("stream/done", map[string]any{
			"sessionId": req.SessionID, "stopReason": "error", "error": err.Error(),
		})
		return nil, err
	}
	return res, nil
}

func (s *server) onSteer(ctx context.Context, params json.RawMessage) (any, error) {
	var req struct {
		SessionID string `json:"sessionId"`
		Text      string `json:"text"`
	}
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, err
	}
	accepted := s.ag != nil && s.ag.Steer(req.SessionID, req.Text)
	return map[string]any{"accepted": accepted}, nil
}

func (s *server) onCancel(ctx context.Context, params json.RawMessage) (any, error) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &a)
	if a.SessionID == "" {
		a.SessionID = "default"
	}
	return map[string]any{"cancelled": s.conn.Cancel(a.SessionID)}, nil
}

func (s *server) onReset(ctx context.Context, params json.RawMessage) (any, error) {
	var a struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &a)
	if a.SessionID == "" {
		a.SessionID = "default"
	}
	if s.ag != nil {
		s.ag.Reset(a.SessionID)
	}
	return map[string]any{"ok": true}, nil
}
