package wordpress

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixturePack(t *testing.T) *Pack {
	t.Helper()
	pack := &Pack{Root: t.TempDir(), Revision: strings.Repeat("a", 40)}
	for _, name := range []string{"wordpress-router", "wp-project-triage", "wp-rest-api", "wp-plugin-development", "wp-block-development", "wp-block-themes", "wp-patterns", "wp-performance", "wp-phpstan", "wp-playground", "blueprint", "wp-abilities-api"} {
		pack.Skills = append(pack.Skills, Skill{Name: name})
		writeFile(t, filepath.Join(pack.Root, "skills", name, "SKILL.md"), "# "+name+"\nUNIQUE_BODY_"+name)
	}
	return pack
}
func writeFile(t *testing.T, file, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func selectedNames(selection Selection) []string {
	names := []string{}
	for _, match := range selection.Matches {
		if match.Loaded {
			names = append(names, match.Name)
		}
	}
	return names
}

func TestDeterministicTaskRouting(t *testing.T) {
	pack := fixturePack(t)
	plain := t.TempDir()
	writeFile(t, filepath.Join(plain, "README.md"), "WordPress plugin REST API performance blueprint")
	plugin := t.TempDir()
	writeFile(t, filepath.Join(plugin, "plugin.php"), "<?php\n/* Plugin Name: Example */")
	for _, tc := range []struct {
		name, root, task string
		want             []string
	}{
		{"non WordPress REST", plain, "Fix REST authentication in server.ts", []string{}},
		{"non WordPress plugin", plain, "Refactor the VS Code plugin settings", []string{}},
		{"PHP alone", plain, "Fix PHP error handling", []string{}},
		{"WordPress REST", plain, "Add a WordPress REST endpoint", []string{"wp-rest-api"}},
		{"project marker", plugin, "Fix permission_callback for the REST endpoint", []string{"wp-rest-api"}},
		{"plugin security", plugin, "Fix nonce validation and escaping", []string{"wp-plugin-development"}},
		{"blocks", plain, "Fix a Gutenberg block.json attribute", []string{"wp-block-development"}},
		{"themes", plugin, "Fix global styles in theme.json", []string{"wp-block-themes"}},
		{"patterns", plugin, "Register a block pattern", []string{"wp-patterns"}},
		{"performance", plugin, "Profile slow queries and caching", []string{"wp-performance"}},
		{"explicit unknown domain", plain, "Use wp-phpstan", []string{"wp-phpstan"}},
		{"unrelated task in plugin", plugin, "Correct the spelling in README.md", []string{}},
		{"empty focus", plugin, "", []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first := Select(pack, tc.root, tc.task, nil, MaxAutoBytes)
			if got := selectedNames(first); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("selected %v, want %v (%+v)", got, tc.want, first.Matches)
			}
			for i := 0; i < 5; i++ {
				if !reflect.DeepEqual(first, Select(pack, tc.root, tc.task, nil, MaxAutoBytes)) {
					t.Fatal("routing changed for identical inputs")
				}
			}
		})
	}
}

func TestBoundedWholeSkillsAndLazyReferences(t *testing.T) {
	pack := fixturePack(t)
	writeFile(t, filepath.Join(pack.Root, "skills", "wp-rest-api", "SKILL.md"), strings.Repeat("REST body. ", 500))
	writeFile(t, filepath.Join(pack.Root, "skills", "wp-rest-api", "references", "auth.md"), "NEVER_AUTOLOAD_REFERENCE")
	writeFile(t, filepath.Join(pack.Root, "skills", "blueprint", "SKILL.md"), strings.Repeat("OVERSIZED_BODY", 2000))
	for _, budget := range []int{0, 200, 4000, MaxAutoBytes, 50000} {
		selection := Select(pack, t.TempDir(), "WordPress REST plugin performance blueprint wp-block-development", nil, budget)
		if selection.Bytes > MaxAutoBytes || selection.Bytes > budget {
			t.Fatalf("context exceeded byte cap: %d > %d", selection.Bytes, budget)
		}
		if len(selectedNames(selection)) > 2 {
			t.Fatal("more than two bodies loaded")
		}
		if strings.Contains(selection.Text, "NEVER_AUTOLOAD_REFERENCE") || strings.Contains(selection.Text, "OVERSIZED_BODY") {
			t.Fatal("loaded a reference or truncated an oversized skill")
		}
	}
}

func TestPackFallbackAndResourceBoundary(t *testing.T) {
	pack := fixturePack(t)
	bundled := t.TempDir()
	manifest, _ := json.Marshal(pack)
	writeFile(t, filepath.Join(bundled, "active.json"), `{"revision":"`+pack.Revision+`"}`)
	writeFile(t, filepath.Join(bundled, pack.Revision, "manifest.json"), string(manifest))
	for _, skill := range pack.Skills {
		writeFile(t, filepath.Join(bundled, pack.Revision, "skills", skill.Name, "SKILL.md"), "fixture")
	}
	override := t.TempDir()
	writeFile(t, filepath.Join(override, "active.json"), `{"revision":"../../outside"}`)
	t.Setenv("MFAGENT_WORDPRESS_SKILLS_HOME", override)
	t.Setenv("MFAGENT_WORDPRESS_SKILLS_BUNDLED", bundled)
	loaded, err := Load()
	if err != nil || loaded.Revision != pack.Revision {
		t.Fatalf("fallback failed: %+v %v", loaded, err)
	}
	for _, file := range []string{"../wp-rest-api/SKILL.md", "../../LICENSE", "/etc/passwd", "C:/secret"} {
		if _, err := pack.Read("wp-plugin-development", file, 0); err == nil {
			t.Errorf("allowed path escape: %s", file)
		}
	}
	writeFile(t, filepath.Join(pack.Root, "skills", "wp-rest-api", "references", "large.md"), strings.Repeat("x", 9000))
	page, err := pack.Read("wp-rest-api", "references/large.md", 0)
	if err != nil || !strings.Contains(page, "offset=6000") || strings.Contains(page, strings.Repeat("x", 6001)) {
		t.Fatalf("bad resource page: %v", err)
	}
	if _, err := pack.Read("wp-rest-api", "references/large.md", 9001); err == nil {
		t.Fatal("out of bounds offset allowed")
	}
}
