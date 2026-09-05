// Package docgen produces markdown documentation for a project, orchestrating
// an LLM provider to generate the narrative and a browser to capture screenshots
// at key points. The output is a set of markdown + PNG files accompanied by a
// manifest JSON that a downstream .docx assembler can consume.
package docgen

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mflores/mfagent/core/internal/browser"
	"github.com/mflores/mfagent/core/internal/llm"
)

// Manifest records every artifact produced by a documentation run so the .docx
// assembler knows exactly what to pick up.
type Manifest struct {
	MarkdownPath string   `json:"markdown"`
	Screenshots  []string `json:"screenshots"`
	GeneratedAt  string   `json:"generatedAt"`
}

// Generator drives a single documentation run.
type Generator struct {
	ProjectPath string
	OutputDir   string
	Provider    llm.Provider
	Browser     *browser.Browser
	ShotDir     string
}

// GenerateMarkdown explores the project directory, calls the LLM to produce
// a structured markdown document, optionally captures browser screenshots for
// any live URL the LLM references, and writes a manifest.json alongside the
// artifacts in OutputDir.
func (g *Generator) GenerateMarkdown(ctx context.Context) (*Manifest, error) {
	if g.ProjectPath == "" {
		return nil, fmt.Errorf("ProjectPath is required")
	}
	if g.OutputDir == "" {
		return nil, fmt.Errorf("OutputDir is required")
	}
	if g.Provider == nil {
		return nil, fmt.Errorf("Provider is required")
	}

	if err := os.MkdirAll(g.OutputDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating output directory: %w", err)
	}

	// Walk the project tree to build a compact listing for the prompt.
	tree, err := buildProjectTree(g.ProjectPath)
	if err != nil {
		return nil, fmt.Errorf("reading project tree: %w", err)
	}

	prompt := fmt.Sprintf(`You are a technical documentation generator. Analyze the project below and produce a complete markdown document suitable for conversion to .docx.

Project root: %s

Directory structure:

%s

Only the directory listing is available. Describe visible structure as fact. Do not
invent file contents, module behavior, dependencies, commands, or configuration.
For details that require reading source files, state that they are not established
by the supplied listing. Label any interpretation of a filename as an inference.

Write a single markdown document that covers:
1. A title (# Project Documentation) and brief overview.
2. The project structure (directories and key files, explained).
3. Build / run instructions (if discoverable).
4. Key modules or packages and what they do.
5. Any configuration or environment setup.
6. Entry points and how they connect.

Use proper markdown headings, lists, and code blocks. Do not include screenshots inline — the assembler will handle those. Output ONLY the markdown content, no preamble or commentary.`, g.ProjectPath, tree)

	req := llm.Request{
		System:   "You are a precise documentation writer. Output valid markdown only.",
		Messages: []llm.Message{llm.UserText(prompt)},
	}

	turn, err := g.Provider.Stream(ctx, req, nil)
	if err != nil {
		return nil, fmt.Errorf("LLM call failed: %w", err)
	}

	md := turn.Text()
	if strings.TrimSpace(md) == "" {
		return nil, fmt.Errorf("LLM returned empty markdown")
	}

	// Write the markdown into OutputDir.
	mdPath := filepath.Join(g.OutputDir, "documentation.md")
	if err := os.WriteFile(mdPath, []byte(md), 0o644); err != nil {
		return nil, fmt.Errorf("writing markdown: %w", err)
	}

	// Capture screenshots if a browser is available and running.
	var shots []string
	if g.Browser != nil && g.Browser.Running() {
		shots, _ = g.captureScreenshots(ctx)
	}

	manifest := &Manifest{
		MarkdownPath: mdPath,
		Screenshots:  shots,
		GeneratedAt:  time.Now().UTC().Format(time.RFC3339),
	}

	manifestPath := filepath.Join(g.OutputDir, "manifest.json")
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshalling manifest: %w", err)
	}
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		return nil, fmt.Errorf("writing manifest: %w", err)
	}

	return manifest, nil
}

// captureScreenshots takes a full-page screenshot of the current browser page.
// Callers can extend this to capture multiple states as needed.
func (g *Generator) captureScreenshots(ctx context.Context) ([]string, error) {
	shotDir := filepath.Join(g.OutputDir, "screenshots")
	if err := os.MkdirAll(shotDir, 0o755); err != nil {
		return nil, err
	}

	// Take a full-page screenshot of whatever the browser currently shows.
	// We write directly via chromedp into our output directory so the manifest
	// paths are self-contained.
	path, err := g.Browser.Screenshot(ctx, "", true)
	if err != nil {
		return nil, err
	}

	// Move the screenshot into our output directory.
	name := fmt.Sprintf("fullpage-%d.png", time.Now().UnixMilli())
	dest := filepath.Join(shotDir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return nil, err
	}

	return []string{dest}, nil
}

// buildProjectTree returns a compact tree-like listing of the project directory.
func buildProjectTree(root string) (string, error) {
	var sb strings.Builder
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		// Skip hidden and well-known noise directories.
		if rel != "." {
			parts := strings.Split(rel, string(filepath.Separator))
			for _, p := range parts {
				if strings.HasPrefix(p, ".") && p != "." {
					return filepath.SkipDir
				}
				if p == "node_modules" || p == "__pycache__" || p == "vendor" {
					return filepath.SkipDir
				}
			}
		}

		if rel == "." {
			return nil
		}

		depth := strings.Count(rel, string(filepath.Separator))
		indent := strings.Repeat("  ", depth)
		name := filepath.Base(path)

		if d.IsDir() {
			fmt.Fprintf(&sb, "%s%s/\n", indent, name)
		} else {
			fmt.Fprintf(&sb, "%s%s\n", indent, name)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return sb.String(), nil
}
