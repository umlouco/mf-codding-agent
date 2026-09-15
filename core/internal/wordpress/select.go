package wordpress

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type Match struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
	Score  int    `json:"score"`
	Loaded bool   `json:"loaded"`
}
type Selection struct {
	Revision string  `json:"revision,omitempty"`
	Matches  []Match `json:"matches"`
	Text     string  `json:"text"`
	Bytes    int     `json:"bytes"`
}
type rule struct {
	name    string
	score   int
	pattern *regexp.Regexp
}

func domain(name string, score int, pattern string) rule {
	return rule{name, score, regexp.MustCompile("(?i)" + pattern)}
}

// Versioned, reviewable rules. Workspace evidence gates generic terms such as
// REST, performance and plugins; the current task determines which domains load.
var rules = []rule{
	domain("wp-abilities-audit", 110, `abilities?[^\n]{0,60}audit|audit[^\n]{0,60}abilities`),
	domain("wp-abilities-verify", 110, `abilities?[^\n]{0,60}verif|verif[^\n]{0,60}abilities`),
	domain("wp-abilities-api", 90, `abilities api|wp_register_ability|wp-abilities/v1|@wordpress/abilities`),
	domain("wp-interactivity-api", 100, `interactivity api|data-wp-|@wordpress/interactivity|viewScriptModule`),
	domain("wp-rest-api", 90, `\brest\b|register_rest_route|permission_callback|wp-json`),
	domain("wp-block-development", 90, `block\.json|registerBlockType|register_block_type|\bgutenberg\b|\bblocks?\b.*\b(attributes|render|deprecat|serializ)|\b(create|build|develop|custom)\b.*\bblock\b`),
	domain("wp-block-themes", 90, `theme\.json|block themes?|global styles|templates/[^\s]+\.html|style variations`),
	domain("wp-patterns", 95, `block patterns?|register_block_pattern|pattern categor|synced patterns`),
	domain("wp-plugin-directory-guidelines", 100, `plugin (directory|review|guidelines)|wordpress\.org.*(submit|guidelines|release)|wp\.org|readme\.txt|directory guidelines`),
	domain("wp-phpstan", 95, `\bphpstan\b|static analysis|phpstan[-.]`),
	domain("wp-performance", 85, `\bperformance\b|\bcach(e|ing)\b|profil(e|ing)|slow quer|\btransients?\b|server-timing`),
	domain("wp-wpcli-and-ops", 85, `wp-cli|\bwp (plugin|theme|core|option|search-replace|db|site|user)\b|\bmultisite\b|database migration`),
	domain("blueprint", 95, `\bblueprints?\b`),
	domain("wp-playground", 90, `\bplayground\b|run-blueprint|build-snapshot|@wp-playground/cli`),
	domain("wpds", 90, `\bwpds\b|wordpress design system|@wordpress/components`),
	domain("wp-plugin-development", 50, `\bplugins?\b|\bhooks?\b|activation|uninstall|settings api|admin (page|menu)|\bnonces?\b|saniti[sz]|escaping|capabilit|shortcode|\bcron\b|add_action|add_filter`),
	domain("wp-project-triage", 80, `\btriage\b|detect.*(project|version|tooling)|classify.*(repo|project)`),
}
var explicitWP = regexp.MustCompile(`(?i)\bwordpress\b|\bwp[-_/]|\bgutenberg\b|@wordpress/|data-wp-|\bwp_[a-z_]+`)
var pluginHeader = regexp.MustCompile(`(?mi)^\s*(?:/\*+|\*|//)?\s*Plugin Name\s*:`)
var themeHeader = regexp.MustCompile(`(?mi)^\s*(?:/\*+|\*|//)?\s*Theme Name\s*:`)

// No dependency trees, docs, generated output, or historical log scans. At most
// 160 entries, two levels and 8 KiB per candidate; symlinks are not traversed.
func workspaceIsWordPress(root string, paths []string) bool {
	for _, name := range []string{"wp-content", "wp-includes/version.php"} {
		if _, err := os.Stat(filepath.Join(root, name)); err == nil {
			return true
		}
	}
	inspect := func(file string) bool {
		base := filepath.Base(file)
		if base != "package.json" && base != "composer.json" && base != "style.css" && base != "theme.json" && base != "block.json" && filepath.Ext(base) != ".php" {
			return false
		}
		data, err := readLimit(file, 8192)
		if err != nil {
			return false
		}
		body := string(data)
		return pluginHeader.MatchString(body) || themeHeader.MatchString(body) ||
			(base == "package.json" || base == "composer.json") && strings.Contains(body, "wordpress") ||
			(base == "theme.json" || base == "block.json") && (strings.Contains(body, "schemas.wp.org") || strings.Contains(body, "apiVersion"))
	}
	for _, file := range paths {
		if !filepath.IsAbs(file) {
			file = filepath.Join(root, file)
		}
		rel, err := filepath.Rel(root, file)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && inspect(file) {
			return true
		}
	}
	ignored := map[string]bool{".git": true, ".mfagent": true, "node_modules": true, "vendor": true, "runtime": true, "dist": true, "build": true, "out": true, "docs": true, "tests": true, "test": true}
	remaining := 160
	var scan func(string, int) bool
	scan = func(dir string, depth int) bool {
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			if remaining == 0 {
				return false
			}
			remaining--
			if entry.Type()&os.ModeSymlink != 0 || ignored[entry.Name()] || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			full := filepath.Join(dir, entry.Name())
			if entry.IsDir() {
				if depth > 0 && scan(full, depth-1) {
					return true
				}
			} else if inspect(full) {
				return true
			}
		}
		return false
	}
	return scan(root, 1)
}

// Select adds at most two whole SKILL.md bodies. Oversized skills are advertised
// for paged loading, never silently cut in the middle of their instructions.
func Select(pack *Pack, root, task string, paths []string, budget int) Selection {
	result := Selection{Matches: []Match{}}
	if pack == nil || strings.TrimSpace(task) == "" || budget <= 0 {
		return result
	}
	if budget > MaxAutoBytes {
		budget = MaxAutoBytes
	}
	if len(task) > 24000 {
		task = task[:24000]
	}
	if len(paths) > 8 {
		paths = paths[:8]
	}
	focus := task + "\n" + strings.Join(paths, "\n")
	explicit := map[string]bool{}
	for _, skill := range pack.Skills {
		if strings.Contains(task, skill.Name) {
			explicit[skill.Name] = true
		}
	}
	if len(explicit) == 0 && !explicitWP.MatchString(focus) && !workspaceIsWordPress(root, paths) {
		return result
	}
	for _, rule := range rules {
		if !pack.Has(rule.name) {
			continue
		}
		if matched := rule.pattern.FindString(focus); matched != "" {
			result.Matches = append(result.Matches, Match{Name: rule.name, Score: rule.score, Reason: "task/path matched " + matched})
		}
	}
	for name := range explicit {
		found := false
		for i := range result.Matches {
			if result.Matches[i].Name == name {
				result.Matches[i].Score = 1000
				result.Matches[i].Reason = "explicit skill name"
				found = true
			}
		}
		if !found {
			result.Matches = append(result.Matches, Match{Name: name, Score: 1000, Reason: "explicit skill name"})
		}
	}
	if len(result.Matches) == 0 && explicitWP.MatchString(task) && pack.Has("wordpress-router") {
		result.Matches = append(result.Matches, Match{Name: "wordpress-router", Score: 1, Reason: "WordPress task needs classification"})
	}
	if len(result.Matches) == 0 {
		return result
	}
	sort.Slice(result.Matches, func(i, j int) bool {
		if result.Matches[i].Score != result.Matches[j].Score {
			return result.Matches[i].Score > result.Matches[j].Score
		}
		return result.Matches[i].Name < result.Matches[j].Name
	})
	if len(result.Matches) > 4 {
		result.Matches = result.Matches[:4]
	}
	result.Revision = pack.Revision
	header := fmt.Sprintf("\n# Relevant official WordPress skills\nRevision: %s. Selected deterministically for this turn only; owner target/version constraints take precedence. References and scripts are not preloaded. Read more with wordpress_skill {\"skill\":\"<name>\",\"file\":\"references/<name>.md\"}. Upstream skills/ paths refer to %s/skills/; run helpers from the workspace cwd.\n", pack.Revision, pack.Root)
	if len(header) > budget {
		return Selection{Matches: []Match{}}
	}
	result.Text = header
	loaded := 0
	for i := range result.Matches {
		match := &result.Matches[i]
		prefix := fmt.Sprintf("\n## %s (%s)\n", match.Name, match.Reason)
		file, err := pack.ResourcePath(match.Name, "SKILL.md")
		var body []byte
		if err == nil {
			body, err = readLimit(file, MaxAutoBytes+1)
		}
		if err == nil && loaded < 2 && len(result.Text)+len(prefix)+len(body) <= budget {
			result.Text += prefix + string(body)
			match.Loaded = true
			loaded++
		} else {
			note := fmt.Sprintf("\nAdditional relevant skill %s: load on demand with wordpress_skill; not included in this turn's size budget.\n", match.Name)
			if len(result.Text)+len(note) <= budget {
				result.Text += note
			}
		}
	}
	result.Bytes = len(result.Text)
	return result
}
