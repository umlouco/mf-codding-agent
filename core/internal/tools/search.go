package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// skipDirs are never walked. Keeping this list tight is what makes search fast
// enough to not need a native ripgrep dependency.
var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"out": true, "build": true, ".next": true, ".nuxt": true,
	"__pycache__": true, ".venv": true, "venv": true, ".idea": true,
	".mfagent": true, "bin": true, "obj": true, "__history": true, // __history: Delphi
	"coverage": true, ".gradle": true, "target": true, ".cache": true,
}

// langGlobs maps the stack this agent is built for to file extensions.
var langGlobs = map[string][]string{
	"php":    {".php", ".phtml", ".inc"},
	"js":     {".js", ".mjs", ".cjs", ".jsx"},
	"ts":     {".ts", ".tsx", ".mts", ".cts"},
	"go":     {".go"},
	"delphi": {".pas", ".dpr", ".dpk", ".dfm", ".fmx", ".inc"},
	"sql":    {".sql"},
	"web":    {".html", ".htm", ".css", ".scss", ".vue", ".svelte"},
	"config": {".json", ".yaml", ".yml", ".toml", ".ini", ".env"},
}

func extsFor(lang string) []string {
	if lang == "" {
		return nil
	}
	return langGlobs[strings.ToLower(lang)]
}

func walkFiles(root string, fn func(abs string, d fs.DirEntry) error) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal
		}
		if d.IsDir() {
			name := d.Name()
			if p != root && (skipDirs[name] || strings.HasPrefix(name, ".") && name != ".github") {
				return filepath.SkipDir
			}
			return nil
		}
		return fn(p, d)
	})
}

func RegisterSearch(r *Registry) {
	r.Add(&Tool{
		Name: "glob",
		Description: "Find files by glob pattern (supports ** for recursive matching). " +
			"Returns paths sorted by modification time, newest first. " +
			"Use this to locate files when you know part of the name.",
		Schema: obj(map[string]any{
			"pattern": str(`Glob such as "src/**/*.ts" or "**/*.pas".`),
			"path":    str("Directory to search under. Defaults to the workspace root."),
			"limit":   num("Maximum results. Default 200."),
		}, "pattern"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Pattern string `json:"pattern"`
				Path    string `json:"path"`
				Limit   int    `json:"limit"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.Limit <= 0 {
				a.Limit = 200
			}
			base := env.Root
			if a.Path != "" {
				var err error
				if base, err = env.Resolve(a.Path); err != nil {
					return Errf("%v", err)
				}
			}
			type hit struct {
				path string
				mod  int64
			}
			var hits []hit
			_ = walkFiles(base, func(abs string, d fs.DirEntry) error {
				rel, err := filepath.Rel(base, abs)
				if err != nil {
					return nil
				}
				rel = filepath.ToSlash(rel)
				if ok, _ := doublestar.Match(a.Pattern, rel); !ok {
					// Also try matching the bare filename so "*.go" works.
					if ok2, _ := doublestar.Match(a.Pattern, filepath.Base(rel)); !ok2 {
						return nil
					}
				}
				info, err := d.Info()
				var m int64
				if err == nil {
					m = info.ModTime().Unix()
				}
				hits = append(hits, hit{env.Rel(abs), m})
				return nil
			})
			sort.Slice(hits, func(i, j int) bool { return hits[i].mod > hits[j].mod })
			if len(hits) == 0 {
				return Ok("No files matched " + a.Pattern)
			}
			truncated := false
			if len(hits) > a.Limit {
				hits = hits[:a.Limit]
				truncated = true
			}
			var sb strings.Builder
			for _, h := range hits {
				sb.WriteString(h.path)
				sb.WriteByte('\n')
			}
			if truncated {
				fmt.Fprintf(&sb, "(truncated at %d results)\n", a.Limit)
			}
			return Ok(sb.String())
		},
	})

	r.Add(&Tool{
		Name: "grep",
		Description: "Search file contents with a Go regular expression. Returns matching lines " +
			"with file:line prefixes. Filter with the glob or lang parameter to keep results tight.",
		Schema: obj(map[string]any{
			"pattern":         str("Go regular expression (RE2 syntax)."),
			"path":            str("Directory or single file to search. Defaults to workspace root."),
			"glob":            str(`Restrict to matching files, e.g. "**/*.php".`),
			"lang":            str("Shorthand file-type filter: php, js, ts, go, delphi, sql, web, config."),
			"case_insensitive": boolp("Match case-insensitively."),
			"context":         num("Lines of context around each match. Default 0."),
			"limit":           num("Maximum matching lines. Default 200."),
			"files_only":      boolp("Return only the list of matching file paths."),
		}, "pattern"),
		Run: func(ctx context.Context, env *Env, in json.RawMessage) Result {
			var a struct {
				Pattern         string `json:"pattern"`
				Path            string `json:"path"`
				Glob            string `json:"glob"`
				Lang            string `json:"lang"`
				CaseInsensitive bool   `json:"case_insensitive"`
				Context         int    `json:"context"`
				Limit           int    `json:"limit"`
				FilesOnly       bool   `json:"files_only"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.Limit <= 0 {
				a.Limit = 200
			}
			expr := a.Pattern
			if a.CaseInsensitive {
				expr = "(?i)" + expr
			}
			re, err := regexp.Compile(expr)
			if err != nil {
				return Errf("invalid regular expression: %v", err)
			}

			base := env.Root
			if a.Path != "" {
				if base, err = env.Resolve(a.Path); err != nil {
					return Errf("%v", err)
				}
			}
			exts := extsFor(a.Lang)

			var out strings.Builder
			var files []string
			count := 0
			stop := fmt.Errorf("limit")

			search := func(abs string) error {
				rel := env.Rel(abs)
				if a.Glob != "" {
					relToBase, _ := filepath.Rel(base, abs)
					relToBase = filepath.ToSlash(relToBase)
					m1, _ := doublestar.Match(a.Glob, relToBase)
					m2, _ := doublestar.Match(a.Glob, filepath.Base(relToBase))
					if !m1 && !m2 {
						return nil
					}
				}
				if len(exts) > 0 {
					ext := strings.ToLower(filepath.Ext(abs))
					found := false
					for _, e := range exts {
						if ext == e {
							found = true
							break
						}
					}
					if !found {
						return nil
					}
				}
				f, err := os.Open(abs)
				if err != nil {
					return nil
				}
				defer f.Close()

				sc := bufio.NewScanner(f)
				sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
				var window []string
				lineNo := 0
				fileMatched := false
				pendingAfter := 0
				for sc.Scan() {
					lineNo++
					line := sc.Text()
					if lineNo == 1 && looksBinary([]byte(line)) {
						return nil
					}
					if re.MatchString(line) {
						fileMatched = true
						if a.FilesOnly {
							files = append(files, rel)
							return nil
						}
						if a.Context > 0 {
							start := lineNo - len(window)
							for i, w := range window {
								fmt.Fprintf(&out, "%s:%d-%s\n", rel, start+i, w)
							}
						}
						fmt.Fprintf(&out, "%s:%d:%s\n", rel, lineNo, line)
						count++
						if count >= a.Limit {
							return stop
						}
						pendingAfter = a.Context
						window = window[:0]
						continue
					}
					if pendingAfter > 0 {
						fmt.Fprintf(&out, "%s:%d-%s\n", rel, lineNo, line)
						pendingAfter--
					}
					if a.Context > 0 {
						window = append(window, line)
						if len(window) > a.Context {
							window = window[1:]
						}
					}
				}
				_ = fileMatched
				return nil
			}

			if fi, err := os.Stat(base); err == nil && !fi.IsDir() {
				_ = search(base)
			} else {
				_ = walkFiles(base, func(abs string, d fs.DirEntry) error { return search(abs) })
			}

			if a.FilesOnly {
				if len(files) == 0 {
					return Ok("No files matched.")
				}
				sort.Strings(files)
				return Ok(strings.Join(files, "\n"))
			}
			if out.Len() == 0 {
				return Ok("No matches.")
			}
			if count >= a.Limit {
				fmt.Fprintf(&out, "(truncated at %d matches)\n", a.Limit)
			}
			return Ok(out.String())
		},
	})
}
