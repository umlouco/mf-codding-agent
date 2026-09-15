package agent

import (
	"github.com/mflores/mfagent/core/internal/llm"
	"path/filepath"
	"strings"
)

// Background editor tabs are not task intent. A selected snippet or a file
// explicitly named by this assignment may contribute a path routing signal.
func skillFocusPaths(req SendRequest, task string) []string {
	var paths []string
	if req.Selection != "" && req.SelectionPath != "" {
		paths = append(paths, req.SelectionPath)
	}
	for _, file := range req.OpenFiles {
		if strings.Contains(task, file) || strings.Contains(task, filepath.Base(file)) {
			paths = append(paths, file)
		}
		if len(paths) >= 8 {
			break
		}
	}
	return paths
}

// Keep call/result pairs valid while removing old skill text from model context.
// The durable transcript remains intact; non-skill evidence is never modified.
func boundWordPressResources(messages []llm.Message, turnStart int) []llm.Message {
	calls := map[string]bool{}
	for _, message := range messages {
		for _, block := range message.Blocks {
			if block.Type == llm.BlockToolUse && block.Name == "wordpress_skill" {
				calls[block.ID] = true
			}
		}
	}
	out := append([]llm.Message(nil), messages...)
	kept := 0
	for i := len(out) - 1; i >= 0; i-- {
		out[i].Blocks = append([]llm.Block(nil), out[i].Blocks...)
		for j := len(out[i].Blocks) - 1; j >= 0; j-- {
			block := &out[i].Blocks[j]
			if block.Type != llm.BlockToolResult || !calls[block.ToolUseID] {
				continue
			}
			if i >= turnStart && kept < 2 {
				kept++
				continue
			}
			block.Text = "[WordPress skill resource omitted from active context. Reload the needed page with wordpress_skill.]"
		}
	}
	return out
}
