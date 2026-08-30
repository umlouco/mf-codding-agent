package tools

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
)

// Region is one deterministically-sized slice of a workspace: a directory (or
// the root's own loose files, as ".") whose file count is at or under the
// ceiling a caller asked for.
//
// Regions exist so that "is this slice of the codebase small enough to
// explore in one agent turn" is answered by counting files, not by asking a
// model to judge its own context budget after the fact. See ScanRegions.
type Region struct {
	Path      string         `json:"path"`
	FileCount int            `json:"fileCount"`
	Languages map[string]int `json:"languages"`
}

// langOrder breaks ties when an extension appears under more than one
// language bucket in langGlobs (".inc" is both PHP and Delphi) — the same
// precedence detectProject already displays in, so a region's reported
// language mix reads the same way the rest of the tool surface does.
var langOrder = []string{"php", "ts", "js", "go", "delphi", "web", "sql", "config"}

var extToLang = buildExtToLang()

func buildExtToLang() map[string]string {
	m := map[string]string{}
	for _, lang := range langOrder {
		for _, ext := range langGlobs[lang] {
			if _, exists := m[ext]; !exists {
				m[ext] = lang
			}
		}
	}
	return m
}

func langOf(ext string) string {
	return extToLang[strings.ToLower(ext)]
}

// dirNode is one directory in the tree ScanRegions builds while walking the
// workspace once. `direct` counts only files that sit immediately inside this
// directory — the recursive total a region needs is computed on demand by
// total(), so the tree itself stays a plain shape of the filesystem.
type dirNode struct {
	direct   int
	langs    map[string]int
	children map[string]*dirNode
}

func newDirNode() *dirNode {
	return &dirNode{langs: map[string]int{}, children: map[string]*dirNode{}}
}

func (n *dirNode) total() int {
	sum := n.direct
	for _, c := range n.children {
		sum += c.total()
	}
	return sum
}

func (n *dirNode) totalLangs() map[string]int {
	out := make(map[string]int, len(n.langs))
	for k, v := range n.langs {
		out[k] += v
	}
	for _, c := range n.children {
		for k, v := range c.totalLangs() {
			out[k] += v
		}
	}
	return out
}

func cloneLangs(m map[string]int) map[string]int {
	out := make(map[string]int, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ScanRegions partitions root into regions no larger than maxPerRegion files,
// descending into any directory whose recursive file count exceeds the
// ceiling and accepting its immediate files and each child directory as
// their own regions instead.
//
// This is the deterministic half of planning: it decides how big a slice of
// the workspace one agent turn will be asked to explore, once, up front, the
// same way for a ten-file repo and a ten-thousand-file one — so that decision
// never has to be re-made by a model sizing its own work mid-turn.
func ScanRegions(root string, maxPerRegion int) ([]Region, error) {
	if maxPerRegion <= 0 {
		maxPerRegion = 1
	}

	tree := newDirNode()
	err := walkFiles(root, func(abs string, d fs.DirEntry) error {
		rel, relErr := filepath.Rel(root, abs)
		if relErr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		parts := strings.Split(rel, "/")

		n := tree
		for _, name := range parts[:len(parts)-1] {
			c, ok := n.children[name]
			if !ok {
				c = newDirNode()
				n.children[name] = c
			}
			n = c
		}
		n.direct++
		if lang := langOf(filepath.Ext(abs)); lang != "" {
			n.langs[lang]++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	var regions []Region
	partitionInto(&regions, "", tree, maxPerRegion)
	sort.Slice(regions, func(i, j int) bool { return regions[i].Path < regions[j].Path })
	return regions, nil
}

// partitionInto appends the regions found under one directory node, recursing
// only where the ceiling forces it.
func partitionInto(out *[]Region, path string, n *dirNode, maxPerRegion int) {
	total := n.total()
	if total == 0 {
		return
	}
	if total <= maxPerRegion || len(n.children) == 0 {
		*out = append(*out, Region{Path: displayPath(path), FileCount: total, Languages: n.totalLangs()})
		return
	}

	// Oversized with subdirectories to divide on: the files sitting directly
	// here have no further directory structure to split by, so they become
	// their own region; each child directory is then partitioned on its own.
	if n.direct > 0 {
		*out = append(*out, Region{Path: displayPath(path), FileCount: n.direct, Languages: cloneLangs(n.langs)})
	}
	names := make([]string, 0, len(n.children))
	for name := range n.children {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		childPath := name
		if path != "" {
			childPath = path + "/" + name
		}
		partitionInto(out, childPath, n.children[name], maxPerRegion)
	}
}

func displayPath(path string) string {
	if path == "" {
		return "."
	}
	return path
}
