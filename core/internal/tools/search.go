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
		Description: "Search file contents with a Go regular expression. By default returns matching " +
			"lines with file:line prefixes. output_mode switches that to a list of matching " +
			"files or to per-file counts with a total, and capture extracts one group from " +
			"every match — every match on a line, not just the first — so a list of names, " +
			"paths or identifiers comes back directly, with unique to deduplicate it. " +
			"Between them these answer \"what matches\", \"where\" and \"how many\" in one " +
			"call, so there is no reason to pipe this into sort, uniq or wc in a shell, " +
			"and no chance of two hand-built pipelines disagreeing about the count. " +
			"Filter with the glob or lang parameter to keep results tight.",
		Schema: obj(map[string]any{
			"pattern":          str("Go regular expression (RE2 syntax)."),
			"path":             str("Directory or single file to search. Defaults to workspace root."),
			"glob":             str(`Restrict to matching files, e.g. "**/*.php".`),
			"lang":             str("Shorthand file-type filter: php, js, ts, go, delphi, sql, web, config."),
			"case_insensitive": boolp("Match case-insensitively."),
			"context":          num("Lines of context around each match. Default 0. Ignored when capture or unique is set."),
			"limit":            num(`Maximum results. Default 200. Ignored by output_mode "count", which always counts everything so the total is exact.`),
			"output_mode": str(`"content" (default) for matching lines, "files" for the list of ` +
				`matching file paths, "count" for a per-file count and a total.`),
			"capture": num("Emit only this capture group of each match instead of the whole line: " +
				"0 for the whole match, 1 for the first parenthesised group. Every match on a " +
				"line is extracted, not only the first."),
			"unique": boolp("Deduplicate and sort the emitted values, dropping the file:line prefix " +
				`since a deduplicated value has no single location. With output_mode "count", ` +
				"reports how many distinct values there are alongside the raw total."),
			"files_only": boolp(`Deprecated alias for output_mode "files".`),
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
				OutputMode      string `json:"output_mode"`
				Capture         *int   `json:"capture"`
				Unique          bool   `json:"unique"`
				FilesOnly       bool   `json:"files_only"`
			}
			if err := json.Unmarshal(in, &a); err != nil {
				return Errf("bad input: %v", err)
			}
			if a.Limit <= 0 {
				a.Limit = 200
			}
			mode := strings.ToLower(strings.TrimSpace(a.OutputMode))
			if mode == "" {
				mode = "content"
				if a.FilesOnly {
					mode = "files"
				}
			}
			switch mode {
			case "content", "files", "count":
			default:
				return Errf("unknown output_mode %q: use \"content\", \"files\" or \"count\"", a.OutputMode)
			}

			expr := a.Pattern
			if a.CaseInsensitive {
				expr = "(?i)" + expr
			}
			re, err := regexp.Compile(expr)
			if err != nil {
				return Errf("invalid regular expression: %v", err)
			}
			if a.Capture != nil {
				if *a.Capture < 0 {
					return Errf("capture must not be negative: 0 is the whole match, 1 the first group")
				}
				if *a.Capture > re.NumSubexp() {
					return Errf("capture group %d does not exist: the pattern has %d parenthesised group(s). "+
						"Add the group to the pattern, or pass capture 0 for the whole match",
						*a.Capture, re.NumSubexp())
				}
			}
			// Extraction reports one result per match; plain search reports one
			// per matching line. Both are "a hit", and the difference has to be
			// said out loud or the two counts look like a contradiction.
			extracting := a.Capture != nil
			// Context is a way of reading a match in place. Once the output is a
			// deduplicated or extracted list, there is no place left to read it in.
			if extracting || a.Unique {
				a.Context = 0
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
			// Counting mode has to see every hit or the total it reports is a
			// lie, so it is the one mode the limit does not apply to.
			counting := mode == "count"
			perFile := map[string]int{}
			var fileOrder []string
			distinct := map[string]bool{}
			var values []string // deduplicated, for unique
			total := 0
			count := 0
			stop := fmt.Errorf("limit")

			// record takes one hit and files it into whichever accumulators the
			// current mode reads at the end.
			record := func(rel string, lineNo int, text string) {
				total++
				if _, seen := perFile[rel]; !seen {
					fileOrder = append(fileOrder, rel)
				}
				perFile[rel]++
				if a.Unique {
					if !distinct[text] {
						distinct[text] = true
						values = append(values, text)
					}
					return
				}
				if counting {
					return
				}
				fmt.Fprintf(&out, "%s:%d:%s\n", rel, lineNo, text)
			}

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
						if mode == "files" {
							files = append(files, rel)
							return nil
						}
						if a.Context > 0 {
							start := lineNo - len(window)
							for i, w := range window {
								fmt.Fprintf(&out, "%s:%d-%s\n", rel, start+i, w)
							}
						}
						if extracting {
							// A uses clause, an import list or an attribute
							// table routinely puts several matches on one
							// line, and taking only the first is how an
							// extracted list silently comes up short.
							for _, m := range re.FindAllStringSubmatch(line, -1) {
								record(rel, lineNo, m[*a.Capture])
								count++
								if !counting && count >= a.Limit {
									return stop
								}
							}
						} else {
							record(rel, lineNo, line)
							count++
							if !counting && count >= a.Limit {
								return stop
							}
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

			// What a hit is depends on the mode, so every summary line below
			// says which one it counted. "412 matches" and "170 matching
			// lines" over the same pattern are both right and look like a
			// contradiction if neither says what it measured.
			unit := "matching lines"
			if extracting {
				unit = "matches"
			}

			switch mode {
			case "files":
				if len(files) == 0 {
					return Ok("No files matched.")
				}
				sort.Strings(files)
				return Ok(strings.Join(files, "\n"))

			case "count":
				if total == 0 {
					return Ok("No matches.")
				}
				sort.Strings(fileOrder)
				for _, f := range fileOrder {
					fmt.Fprintf(&out, "%s:%d\n", f, perFile[f])
				}
				fmt.Fprintf(&out, "\ntotal: %d %s across %d file(s)", total, unit, len(fileOrder))
				if a.Unique {
					fmt.Fprintf(&out, "\ndistinct: %d", len(values))
				}
				return Ok(out.String() + "\n")
			}

			if a.Unique {
				if len(values) == 0 {
					return Ok("No matches.")
				}
				sort.Strings(values)
				if len(values) > a.Limit {
					values = values[:a.Limit]
				}
				body := strings.Join(values, "\n")
				note := fmt.Sprintf("\n\n(%d distinct of %d %s)", len(distinct), total, unit)
				if len(distinct) > len(values) {
					note = fmt.Sprintf("\n\n(showing %d of %d distinct, from %d %s; raise limit for the rest)",
						len(values), len(distinct), total, unit)
				}
				return Ok(body + note)
			}
			if out.Len() == 0 {
				return Ok("No matches.")
			}
			if count >= a.Limit {
				fmt.Fprintf(&out, "(truncated at %d %s — use output_mode \"count\" for the real total)\n",
					a.Limit, unit)
			}
			return Ok(out.String())
		},
	})
}
