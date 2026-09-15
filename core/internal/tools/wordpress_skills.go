package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mflores/mfagent/core/internal/wordpress"
)

func RegisterWordPressSkills(r *Registry) {
	r.Add(&Tool{Name: "wordpress_skill", Description: "Read an official WordPress skill, reference or helper script on demand. Empty input lists names only. Resources are paged at 6000 bytes; only two recent WordPress resource results remain in native agent context. No script is executed. Use for WordPress work only.",
		Schema: obj(map[string]any{"skill": str("Installed skill name, e.g. wp-rest-api. Omit to list names."), "file": str("Path relative to the skill, default SKILL.md; e.g. references/security.md or scripts/detect_plugins.mjs."), "offset": num("Byte offset for paging, default 0.")}),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var args struct {
				Skill  string `json:"skill"`
				File   string `json:"file"`
				Offset int    `json:"offset"`
			}
			if err := json.Unmarshal(in, &args); err != nil {
				return Errf("bad input: %v", err)
			}
			pack, err := wordpress.Load()
			if err != nil {
				return Errf("%v", err)
			}
			if args.Skill == "" {
				var out strings.Builder
				fmt.Fprintf(&out, "Official WordPress skills %s (%s)\n", pack.Revision, pack.Repository)
				for _, skill := range pack.Skills {
					fmt.Fprintf(&out, "- %s\n", skill.Name)
				}
				out.WriteString("Read one with wordpress_skill {\"skill\":\"<name>\"}. Helpers and references load separately; no automatic script execution.")
				return Ok(out.String())
			}
			body, err := pack.Read(args.Skill, args.File, args.Offset)
			if err != nil {
				return Errf("%v", err)
			}
			return Ok(body)
		},
	})
}
