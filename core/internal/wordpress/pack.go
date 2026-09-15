// Package wordpress loads an immutable official skill pack and selects context without an LLM.
package wordpress

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const MaxAutoBytes = 12000
const MaxResourceBytes = 6000

type Skill struct {
	Name   string `json:"name"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type Pack struct {
	Root       string  `json:"-"`
	Revision   string  `json:"revision"`
	Repository string  `json:"repository"`
	Skills     []Skill `json:"skills"`
}

var revisionPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var namePattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// The explicit update wins; a missing/corrupt update pointer falls back to the VSIX.
func Load() (*Pack, error) {
	for _, home := range []string{os.Getenv("MFAGENT_WORDPRESS_SKILLS_HOME"), os.Getenv("MFAGENT_WORDPRESS_SKILLS_BUNDLED")} {
		if home == "" {
			continue
		}
		var active struct {
			Revision string `json:"revision"`
		}
		data, err := readLimit(filepath.Join(home, "active.json"), 1024)
		if err != nil || json.Unmarshal(data, &active) != nil || !revisionPattern.MatchString(active.Revision) {
			continue
		}
		root := filepath.Join(home, active.Revision)
		data, err = readLimit(filepath.Join(root, "manifest.json"), 65536)
		var pack Pack
		if err != nil || json.Unmarshal(data, &pack) != nil || pack.Revision != active.Revision || len(pack.Skills) == 0 {
			continue
		}
		valid := true
		for _, skill := range pack.Skills {
			if !namePattern.MatchString(skill.Name) {
				valid = false
				break
			}
			info, err := os.Stat(filepath.Join(root, "skills", skill.Name, "SKILL.md"))
			if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || skill.Bytes > 0 && int64(skill.Bytes) != info.Size() {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		pack.Root = root
		return &pack, nil
	}
	return nil, fmt.Errorf("official WordPress skill pack unavailable; run MF Agent: Update WordPress Skills or rebuild with npm run build:wordpress")
}

func readLimit(file string, limit int) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, int64(limit)))
}

func (p *Pack) Has(name string) bool {
	for _, skill := range p.Skills {
		if skill.Name == name {
			return true
		}
	}
	return false
}

func (p *Pack) ResourcePath(name, file string) (string, error) {
	if !p.Has(name) {
		return "", fmt.Errorf("unknown WordPress skill %q; call wordpress_skill {} for the installed catalog", name)
	}
	if file == "" {
		file = "SKILL.md"
	}
	file = filepath.FromSlash(file)
	if filepath.IsAbs(file) || strings.Contains(file, ":") {
		return "", fmt.Errorf("resource must be relative to the selected skill")
	}
	root := filepath.Join(p.Root, "skills", name)
	target := filepath.Join(root, file)
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("resource escapes the selected skill")
	}
	real, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	rel, err = filepath.Rel(realRoot, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("resource symlink escapes the selected skill")
	}
	return target, nil
}

func (p *Pack) Read(name, file string, offset int) (string, error) {
	if offset < 0 {
		return "", fmt.Errorf("offset must be nonnegative")
	}
	target, err := p.ResourcePath(name, file)
	if err != nil {
		return "", err
	}
	f, err := os.Open(target)
	if err != nil {
		return "", err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		return "", fmt.Errorf("resource is not a regular file")
	}
	if int64(offset) > stat.Size() {
		return "", fmt.Errorf("offset exceeds resource size (%d bytes)", stat.Size())
	}
	if _, err := f.Seek(int64(offset), 0); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxResourceBytes))
	if err != nil {
		return "", err
	}
	// Return an offset at a UTF-8 boundary so paging never drops part of a character.
	for trimmed := 0; !utf8.Valid(data) && len(data) > 0 && trimmed < 3; trimmed++ {
		data = data[:len(data)-1]
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("resource is not UTF-8 text or offset starts inside a character")
	}
	return fmt.Sprintf("Official WordPress skills revision %s\nSource: %s\nBytes %d..%d of %d; use offset=%d for the next page.\nSkill helpers run with the workspace as cwd; replace upstream skills/ paths with %s/skills/. Follow owner version/target constraints.\n\n%s",
		p.Revision, target, offset, offset+len(data), stat.Size(), offset+len(data), p.Root, data), nil
}
