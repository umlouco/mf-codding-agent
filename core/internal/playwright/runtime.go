package playwright

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Origin records where a usable @playwright/test came from. It is reported to
// the agent verbatim, because "not installed" and "installed somewhere you did
// not look" are different problems and only one of them is the agent's to fix.
type Origin string

const (
	// OriginProject is the project's own node_modules — a repository that
	// already owns its test dependencies keeps them.
	OriginProject Origin = "project"
	// OriginExternal is MFAGENT_PLAYWRIGHT_ROOT, an owner-selected suite kept
	// outside the application repository.
	OriginExternal Origin = "external"
	// OriginBundled is the copy shipped inside the extension. This is the one
	// that makes the tools work with no project setup at all.
	OriginBundled Origin = "bundled"
	// OriginNone means nothing resolved.
	OriginNone Origin = "none"
)

// bundledHome is the runtime directory shipped in the VSIX, handed to the core
// by the extension. It is a host value, never model input: the extension knows
// its own installation path and nothing else may set it.
//
// The directory is expected to contain node_modules/@playwright/test.
func bundledHome() string {
	return strings.TrimSpace(os.Getenv("MFAGENT_PLAYWRIGHT_HOME"))
}

// pkgDir reports the @playwright/test package directory under a node_modules
// parent, or "" when it is not there.
func pkgDir(home string) string {
	if home == "" {
		return ""
	}
	dir := filepath.Join(home, "node_modules", "@playwright", "test")
	if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
		return dir
	}
	return ""
}

// linkOnce guards the per-root resolution link so concurrent workers sharing a
// workspace do not race to create the same symlink.
var linkOnce sync.Map

// EnsureResolvable makes `require('@playwright/test')` work from the project's
// own specs and config when the runtime lives somewhere else.
//
// Running the bundled CLI is not enough on its own: the CLI resolves its own
// dependencies from beside itself, but a spec's `import { test } from
// '@playwright/test'` resolves by walking up from the spec file, which never
// reaches the extension's directory. So the packages are linked into the
// project rather than the specs being rewritten to know where the runtime is.
//
// Links are used rather than copies so a runtime upgrade does not leave stale
// duplicates behind, and so this stays cheap enough to run on every call.
func EnsureResolvable(root, home string) error {
	if root == "" || home == "" {
		return nil
	}
	key := root + "\x00" + home
	if _, done := linkOnce.LoadOrStore(key, true); done {
		return nil
	}
	src := filepath.Join(home, "node_modules")
	if fi, err := os.Stat(src); err != nil || !fi.IsDir() {
		linkOnce.Delete(key)
		return fmt.Errorf("bundled Playwright runtime is missing at %s", src)
	}
	dst := filepath.Join(root, "node_modules")

	// A project with no node_modules at all gets one link for the whole tree,
	// which is both cheaper and closer to what npm would have produced.
	if _, err := os.Lstat(dst); os.IsNotExist(err) {
		if err := link(src, dst); err == nil {
			return nil
		}
		// Fall through: a failed tree link is recoverable per package.
	}

	// Otherwise link only what Playwright needs, leaving the project's own
	// dependencies untouched. @playwright/test pulls playwright and
	// playwright-core in as real directories beside it.
	if err := os.MkdirAll(filepath.Join(dst, "@playwright"), 0o755); err != nil {
		linkOnce.Delete(key)
		return err
	}
	var failed []string
	for _, rel := range []string{
		filepath.Join("@playwright", "test"),
		"playwright",
		"playwright-core",
	} {
		from := filepath.Join(src, rel)
		if _, err := os.Stat(from); err != nil {
			continue // an optional peer this runtime does not ship
		}
		to := filepath.Join(dst, rel)
		if _, err := os.Lstat(to); err == nil {
			continue // the project already has its own, which wins
		}
		if err := link(from, to); err != nil {
			failed = append(failed, rel+": "+err.Error())
		}
	}
	if len(failed) > 0 {
		linkOnce.Delete(key)
		return errors.New("could not link the bundled Playwright runtime into the project — " + strings.Join(failed, "; "))
	}
	return nil
}

// link prefers a directory symlink and falls back to a junction on Windows,
// where an unprivileged account cannot create symlinks without developer mode.
func link(from, to string) error {
	if err := os.Symlink(from, to); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		return err
	}
	return junction(from, to)
}

// ChromiumPaths returns every Chromium build Playwright has already downloaded
// on this host, newest revision first.
//
// This is the fallback that matters. A machine with no Chrome and no Chromium
// package almost always still has these, because installing Playwright's
// browsers is the one setup step nobody skips — and the build here is the same
// one the project's own specs run against, which makes it the better choice
// even when a system browser does exist.
func ChromiumPaths() []string {
	var roots []string
	if p := strings.TrimSpace(os.Getenv("PLAYWRIGHT_BROWSERS_PATH")); p != "" && p != "0" {
		roots = append(roots, p)
	}
	switch runtime.GOOS {
	case "windows":
		if p := os.Getenv("LOCALAPPDATA"); p != "" {
			roots = append(roots, filepath.Join(p, "ms-playwright"))
		}
	case "darwin":
		if p := os.Getenv("HOME"); p != "" {
			roots = append(roots, filepath.Join(p, "Library", "Caches", "ms-playwright"))
		}
	default:
		if p := os.Getenv("HOME"); p != "" {
			roots = append(roots, filepath.Join(p, ".cache", "ms-playwright"))
		}
	}

	// The headless shell is a smaller build with no headed mode. It is listed
	// after the full builds so a headed run still gets a browser that can do it.
	exes := map[string][]string{
		"windows": {filepath.Join("chrome-win64", "chrome.exe"), filepath.Join("chrome-win", "chrome.exe")},
		"darwin":  {filepath.Join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")},
	}[runtime.GOOS]
	if exes == nil {
		exes = []string{filepath.Join("chrome-linux64", "chrome"), filepath.Join("chrome-linux", "chrome")}
	}

	type build struct {
		rev  int
		path string
		full bool
	}
	var found []build
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			full := strings.HasPrefix(name, "chromium-")
			shell := strings.HasPrefix(name, "chromium_headless_shell-")
			if !full && !shell {
				continue
			}
			rev, _ := strconv.Atoi(name[strings.LastIndex(name, "-")+1:])
			for _, exe := range exes {
				p := filepath.Join(root, name, exe)
				if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
					found = append(found, build{rev: rev, path: p, full: full})
					break
				}
			}
		}
	}
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].full != found[j].full {
			return found[i].full
		}
		return found[i].rev > found[j].rev
	})
	out := make([]string, 0, len(found))
	for _, b := range found {
		out = append(out, b.path)
	}
	return out
}

// PkgDir is the absolute @playwright/test directory this setup resolved to,
// for callers that must require it by path rather than by name.
func (s *Setup) PkgDir() string {
	return pkgDir(s.Home)
}

// Describe renders the resolved runtime for a status report, saying plainly
// where it came from so a worker never has to guess whether setup is its job.
func (s *Setup) Describe() string {
	switch s.Origin {
	case OriginProject:
		return "project (this repository owns @playwright/test)"
	case OriginExternal:
		return "external suite at " + s.Home + " (owner-selected)"
	case OriginBundled:
		return "bundled with the extension at " + s.Home + " — no project install is needed or wanted"
	default:
		return "none resolved"
	}
}
