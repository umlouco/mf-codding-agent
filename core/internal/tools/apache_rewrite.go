package tools

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type apacheRewriteInput struct {
	Action          string `json:"action"`
	Directory       string `json:"directory"`
	BasePath        string `json:"base_path"`
	FrontController string `json:"front_controller"`
	ProbePath       string `json:"probe_path"`
	ExpectedText    string `json:"expected_text"`
	BasicAuth       bool   `json:"basic_auth"`
}

var apacheBasePath = regexp.MustCompile(`^/[A-Za-z0-9_./~-]*$`)
var apacheController = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`)
var apacheBaseRule = regexp.MustCompile(`(?i)^(\s*RewriteBase\s+)\S+(\s*(?:#.*)?)$`)
var apacheEngineOff = regexp.MustCompile(`(?i)^(\s*RewriteEngine\s+)Off(\s*(?:#.*)?)$`)

// Repair only routing directives. Access rules, headers, PHP settings, and custom
// conditions remain byte-for-byte intact. Real HTTP probes decide whether to keep it.
func apacheRewriteCandidate(original, base, controller string) string {
	newline := "\n"
	if strings.Contains(original, "\r\n") {
		newline = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(original, "\r\n", "\n"), "\n")
	foundController := false
	foundEngine := false
	for i, line := range lines {
		parts := strings.Fields(line)
		if len(parts) >= 2 && strings.EqualFold(parts[0], "RewriteEngine") {
			foundEngine = true
		}
		if m := apacheBaseRule.FindStringSubmatch(line); m != nil {
			lines[i] = m[1] + base + m[2]
			continue
		}
		if m := apacheEngineOff.FindStringSubmatch(line); m != nil {
			lines[i] = m[1] + "On" + m[2]
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 || !strings.EqualFold(fields[0], "RewriteRule") {
			continue
		}
		target, query, hasQuery := strings.Cut(fields[2], "?")
		if strings.Contains(target, "://") || strings.Contains(target, "$") || path.Base(target) != controller {
			continue
		}
		foundController = true
		replacement := base + controller
		if hasQuery {
			replacement += "?" + query
		}
		// Replace the substitution token only, preserving its pattern and flags.
		offset := strings.Index(line, fields[1]) + len(fields[1])
		tail := line[offset:]
		lines[i] = line[:offset] + strings.Replace(tail, fields[2], replacement, 1)
	}
	result := strings.Join(lines, newline)
	if foundController && !foundEngine {
		result = "RewriteEngine On" + newline + result
	}
	if !foundController {
		result = strings.TrimRight(result, "\r\n") + newline + strings.Join([]string{
			"# BEGIN MF Agent front controller", "<IfModule mod_rewrite.c>", "RewriteEngine On", "RewriteBase " + base,
			"RewriteCond %{REQUEST_FILENAME} !-f", "RewriteCond %{REQUEST_FILENAME} !-d",
			"RewriteRule ^ " + base + controller + " [END,QSA]", "</IfModule>", "# END MF Agent front controller", "",
		}, newline)
	}
	return result
}

func RegisterApacheRewrite(r *Registry) {
	r.Add(&Tool{Name: "apache_rewrite_check", Mutating: true,
		Description: "Test Apache .htaccess rewrites against the fixed testing URL. Creates a random temporary probe and always removes it. action=repair corrects RewriteBase/front-controller destinations or adds missing standard routing, preserves unrelated directives, backs up the original, and rolls back unless both a real rewrite probe and the specified application route pass. Cannot enable mod_rewrite or AllowOverride in server configuration; reports those blockers. Requires Apache 2.4.",
		Schema: obj(map[string]any{
			"action": str("check (default) or repair."), "directory": str("Workspace-relative directory containing .htaccess and public files. Default ."),
			"base_path":        str("Actual URL mount path of this directory, e.g. /app/. Do not infer it from a deeper application route."),
			"front_controller": str("Existing entrypoint filename, e.g. index.php. Required for repair."),
			"probe_path":       str("An actual application route relative to base_path, without a leading slash. Required for repair."),
			"expected_text":    str("Text the actual application route must return; required for repair so an unrelated 200 page cannot pass."),
			"basic_auth":       boolp("Use configured username/password for HTTP Basic authentication. Default false; application form login is separate."),
		}, "base_path"), Run: runApacheRewrite})
}

func runApacheRewrite(ctx context.Context, env *Env, input json.RawMessage) (result Result) {
	var a apacheRewriteInput
	if err := json.Unmarshal(input, &a); err != nil {
		return Errf("bad input: %v", err)
	}
	if a.Action == "" {
		a.Action = "check"
	}
	if a.Action != "check" && a.Action != "repair" {
		return Errf("action must be check or repair")
	}
	base := strings.TrimRight(a.BasePath, "/") + "/"
	if !apacheBasePath.MatchString(base) || path.Clean(base)+"/" != base && base != "/" || strings.Contains(base, "..") {
		return Errf("base_path must be the absolute URL mount path, with no traversal, query, or whitespace")
	}
	owner, err := url.Parse(env.Testing.URL)
	if err != nil || owner.Host == "" || (owner.Scheme != "http" && owner.Scheme != "https") {
		return Errf("configure the fixed testing URL in the task queue before testing Apache rewrites")
	}
	if a.Directory == "" {
		a.Directory = "."
	}
	directory, err := env.Resolve(a.Directory)
	if err != nil {
		return Errf("%v", err)
	}
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() {
		return Errf("directory is not an existing workspace directory")
	}
	if a.Action == "repair" {
		if !apacheController.MatchString(a.FrontController) || a.ProbePath == "" || strings.TrimSpace(a.ExpectedText) == "" {
			return Errf("repair requires an existing front_controller, an actual probe_path, and expected_text")
		}
		controller, err := env.Resolve(filepath.Join(a.Directory, a.FrontController))
		if err != nil {
			return Errf("%v", err)
		}
		info, err := os.Stat(controller)
		if err != nil || !info.Mode().IsRegular() {
			return Errf("front_controller is not an existing file")
		}
	}
	probeRef, err := url.Parse(a.ProbePath)
	if err != nil || probeRef.IsAbs() || probeRef.Host != "" || strings.HasPrefix(a.ProbePath, "/") || strings.Contains(probeRef.Path, "..") {
		return Errf("probe_path must stay within the supplied URL mount")
	}
	file := filepath.Join(directory, ".htaccess")
	if info, err := os.Lstat(file); err == nil && !info.Mode().IsRegular() {
		return Errf(".htaccess must be a regular file, not a symlink or directory")
	}
	if err := recoverApacheRewrite(env, file); err != nil {
		return Errf("%v", err)
	}
	original, err := os.ReadFile(file)
	existed := err == nil
	if err != nil && !os.IsNotExist(err) {
		return Errf("read .htaccess: %v", err)
	}
	if len(original) > 512*1024 {
		return Errf(".htaccess exceeds the inspection limit")
	}
	mode := os.FileMode(0644)
	if info, err := os.Stat(file); err == nil {
		mode = info.Mode().Perm()
	}
	current := append([]byte(nil), original...)
	changed := false
	keep := false
	var backup string
	var recoveryPath string
	{
		sum := sha256.Sum256(original)
		backup, err = env.Resolve(filepath.Join(".mfagent", "backups", fmt.Sprintf("htaccess-%d-%x.bak", time.Now().UnixNano(), sum[:5])))
		if err != nil {
			return Errf("%v", err)
		}
		if err = os.MkdirAll(filepath.Dir(backup), 0700); err != nil {
			return Errf("backup directory: %v", err)
		}
		if err = os.WriteFile(backup, original, 0600); err != nil {
			return Errf("backup: %v", err)
		}
	}
	write := func(content []byte) error {
		disk, readErr := os.ReadFile(file)
		if readErr != nil && !(os.IsNotExist(readErr) && !changed && !existed) {
			return readErr
		}
		if !bytes.Equal(disk, current) {
			return fmt.Errorf(".htaccess changed concurrently; refusing to overwrite it")
		}
		if err := os.WriteFile(file, content, mode); err != nil {
			return err
		}
		current = append([]byte(nil), content...)
		changed = true
		return nil
	}
	defer func() {
		if !changed || keep {
			if recoveryPath != "" {
				_ = os.Remove(recoveryPath)
			}
			return
		}
		disk, err := os.ReadFile(file)
		if err != nil || !bytes.Equal(disk, current) {
			result = Errf("%s\nCould not restore .htaccess because it changed concurrently. Preserved backup: %s", result.Output, backup)
			return
		}
		if existed {
			err = os.WriteFile(file, original, mode)
		} else {
			err = os.Remove(file)
		}
		if err != nil {
			result = Errf("%s\nRestoration failed: %v. Backup: %s", result.Output, err, backup)
		} else if recoveryPath != "" {
			_ = os.Remove(recoveryPath)
		}
	}()
	candidate := original
	if a.Action == "repair" {
		candidate = []byte(apacheRewriteCandidate(string(original), base, a.FrontController))
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		return Errf("probe token: %v", err)
	}
	token := hex.EncodeToString(random[:])
	name := "mfagent-rewrite-" + token
	probeFile := filepath.Join(directory, name+".txt")
	if err = os.WriteFile(probeFile, []byte(token), 0644); err != nil {
		return Errf("probe file: %v", err)
	}
	defer os.Remove(probeFile)
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if !sameOrigin(owner, req.URL) {
			return fmt.Errorf("probe redirected outside the configured testing origin")
		}
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return nil
	}}
	get := func(route string) (int, string, error) {
		target := owner.Scheme + "://" + owner.Host + base + route
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return 0, "", err
		}
		req.Header.Set("Cache-Control", "no-cache")
		if a.BasicAuth {
			u, uok := env.Testing.Credentials["username"]
			p, pok := env.Testing.Credentials["password"]
			if !uok || !pok {
				return 0, "", fmt.Errorf("HTTP Basic authentication requires configured username and password")
			}
			req.SetBasicAuth(u, p)
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, "", err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		return resp.StatusCode, string(body), err
	}
	// An absolute substitution avoids borrowing a possibly broken RewriteBase.
	probeRules := []byte("# Temporary MF Agent rewrite probe\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteRule ^" + name + "$ " + base + name + ".txt [END]\n</IfModule>\n")
	withProbe := append(probeRules, candidate...)
	recoveryPath, err = recordApacheRecovery(env, apacheRecovery{PID: os.Getpid(), File: file, Backup: backup, Probe: probeFile, Existed: existed, Mode: uint32(mode), Hashes: []string{apacheHash(original), apacheHash(candidate), apacheHash(withProbe)}})
	if err != nil {
		return Errf("record rewrite recovery: %v", err)
	}
	if err = write(withProbe); err != nil {
		return Errf("write probe: %v", err)
	}
	status, body, err := get(name + ".txt")
	if err != nil || status != 200 || body != token {
		return Errf("static directory probe failed (HTTP %d): %v. The configured URL mount may not serve this directory, .htaccess may contain invalid directives, or authentication may be required. Original .htaccess restored.", status, err)
	}
	status, body, err = get(name)
	if err != nil || status != 200 || body != token {
		return Errf("rewrite probe failed (HTTP %d): %v. Confirm Apache mod_rewrite and AllowOverride FileInfo/All for this directory; editing .htaccess cannot enable either server setting. Original .htaccess restored.", status, err)
	}
	if err = write(candidate); err != nil {
		return Errf("remove probe rule: %v", err)
	}
	if a.ProbePath != "" {
		status, body, err = get(a.ProbePath)
		if err != nil || status != 200 || a.ExpectedText != "" && !strings.Contains(body, a.ExpectedText) {
			return Errf("rewrite engine works, but the actual application route failed its required check (HTTP %d): %v. Repair rolled back; inspect the application route, authentication, and custom rules. Backup: %s", status, err, backup)
		}
	}
	if a.Action == "repair" {
		keep = true
		if env.FileChanged != nil {
			env.FileChanged(file)
		}
		return Ok(fmt.Sprintf("Repaired .htaccess. Random rewrite probe and actual application route both passed. Existing access directives preserved. Backup: %s", env.Rel(backup)))
	}
	return Ok("Apache rewrite probe passed against the configured testing host. Temporary files and rules removed; original .htaccess restored.")
}
