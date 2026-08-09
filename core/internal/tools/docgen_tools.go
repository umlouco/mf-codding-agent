package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/mflores/mfagent/core/internal/browser"
	"github.com/mflores/mfagent/core/internal/docgen"
	"github.com/mflores/mfagent/core/internal/llm"
)

// RegisterDocgen adds the docgen_generate tool to the registry. It wires the
// Generator to the ambient LLM provider, browser, and env so the agent can
// generate markdown documentation + screenshots for the current workspace on
// demand.
func RegisterDocgen(r *Registry, b *browser.Browser, env *Env, provider llm.Provider) {
	if provider == nil {
		return
	}

	shotDir := filepath.Join(env.Root, ".mfagent", "screenshots")

	r.Add(&Tool{
		Name: "docgen_generate",
		Description: "Generate markdown documentation for the current workspace, optionally " +
			"capturing browser screenshots. Writes a markdown file, any screenshots, and a " +
			"manifest.json into the output directory so a .docx assembler can pick them up.",
		Mutating: true,
		Schema: obj(map[string]any{
			"project_path": str("Path to the project to document. Defaults to the workspace root."),
			"output_dir":   str("Directory to write documentation into. Defaults to .mfagent/docgen/ under the workspace root."),
		}),
		Summarize: func(in json.RawMessage) string {
			var a struct {
				OutputDir string `json:"output_dir"`
			}
			_ = json.Unmarshal(in, &a)
			target := a.OutputDir
			if target == "" {
				target = ".mfagent/docgen/"
			}
			return "Generate project documentation into " + target
		},
		Run: func(ctx context.Context, toolEnv *Env, in json.RawMessage) Result {
			var a struct {
				ProjectPath string `json:"project_path"`
				OutputDir   string `json:"output_dir"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}

			projectPath := toolEnv.Root
			if a.ProjectPath != "" {
				resolved, err := toolEnv.Resolve(a.ProjectPath)
				if err != nil {
					return Errf("invalid project_path: %v", err)
				}
				projectPath = resolved
			}

			outputDir := filepath.Join(toolEnv.Root, ".mfagent", "docgen")
			if a.OutputDir != "" {
				resolved, err := toolEnv.Resolve(a.OutputDir)
				if err != nil {
					return Errf("invalid output_dir: %v", err)
				}
				outputDir = resolved
			}

			gen := &docgen.Generator{
				ProjectPath: projectPath,
				OutputDir:   outputDir,
				Provider:    provider,
				Browser:     b,
				ShotDir:     shotDir,
			}

			if toolEnv.Emit != nil {
				toolEnv.Emit("docgen", map[string]any{"status": "generating", "project": projectPath})
			}

			manifest, err := gen.GenerateMarkdown(ctx)
			if err != nil {
				return Errf("documentation generation failed: %v", err)
			}

			if toolEnv.Emit != nil {
				toolEnv.Emit("docgen", map[string]any{
					"status":       "done",
					"markdown":     manifest.MarkdownPath,
					"screenshots":  len(manifest.Screenshots),
					"manifest":     filepath.Join(outputDir, "manifest.json"),
				})
			}

			return Ok(fmt.Sprintf(
				"Documentation generated.\nMarkdown: %s\nScreenshots: %d\nManifest: %s/manifest.json",
				toolEnv.Rel(manifest.MarkdownPath),
				len(manifest.Screenshots),
				toolEnv.Rel(outputDir),
			))
		},
	})
}
