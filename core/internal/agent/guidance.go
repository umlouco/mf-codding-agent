package agent

import "strings"

// Steer queues the latest supervisor advice for the next model round. It never
// interrupts a tool or inserts a message between tool calls and their results.
// The caller persists advice separately so an ending turn cannot lose it.
func (a *Agent) Steer(sessionID, text string) bool {
	text = strings.TrimSpace(a.env.TestingPrompt(text))
	if text == "" || len(text) > 16000 {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	sess := a.sessions[sessionID]
	if sess == nil || !sess.running {
		return false
	}
	sess.guidance = text
	return true
}
