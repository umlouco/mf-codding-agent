package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mflores/mfagent/core/internal/config"
)

func TestApacheCandidatePreservesUnrelatedDirectives(t *testing.T) {
	original := "Require all granted\r\nHeader set X-Example keep\r\nRewriteEngine Off\r\nRewriteBase /old/\r\nRewriteCond %{REQUEST_FILENAME} !-f\r\nRewriteRule . /old/index.php?x=1 [L,QSA]\r\n"
	got := apacheRewriteCandidate(original, "/new/", "index.php")
	for _, wanted := range []string{"Require all granted\r\nHeader set X-Example keep", "RewriteEngine On", "RewriteBase /new/", "RewriteCond %{REQUEST_FILENAME} !-f", "RewriteRule . /new/index.php?x=1 [L,QSA]"} {
		if !strings.Contains(got, wanted) {
			t.Fatalf("lost directive %s in %s", wanted, got)
		}
	}
	if !strings.HasPrefix(apacheRewriteCandidate("RewriteRule . index.php [L]\n", "/app/", "index.php"), "RewriteEngine On\n") {
		t.Fatal("missing engine not repaired")
	}
}

// The fake origin exercises HTTP outcome handling; the real Apache replay covers mod_rewrite itself.
func TestApacheProbeOutcomesAndRollback(t *testing.T) {
	for _, mode := range []string{"check", "repair", "rewrite-disabled", "wrong-route", "concurrent-edit"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			original := "Require all granted\nRewriteEngine On\nRewriteBase /wrong/\nRewriteRule . /wrong/index.php [L]\n"
			writeFile(t, root, ".htaccess", original)
			writeFile(t, root, "index.php", "entrypoint")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				name := strings.TrimPrefix(r.URL.Path, "/app/")
				if strings.HasPrefix(name, "mfagent-rewrite-") {
					if !strings.HasSuffix(name, ".txt") && mode == "rewrite-disabled" {
						http.NotFound(w, r)
						return
					}
					if mode == "concurrent-edit" {
						_ = os.WriteFile(filepath.Join(root, ".htaccess"), []byte("owner edit\n"), 0644)
					}
					data, err := os.ReadFile(filepath.Join(root, strings.TrimSuffix(name, ".txt")+".txt"))
					if err != nil {
						http.NotFound(w, r)
						return
					}
					_, _ = w.Write(data)
					return
				}
				if mode == "wrong-route" {
					_, _ = w.Write([]byte("unrelated 200 page"))
					return
				}
				_, _ = w.Write([]byte("application route verified"))
			}))
			defer server.Close()
			env := &Env{Root: root, Testing: config.TestingEnvironment{URL: server.URL + "/app/"}}
			action := "repair"
			if mode == "check" {
				action = "check"
			}
			input, _ := json.Marshal(apacheRewriteInput{Action: action, BasePath: "/app/", FrontController: "index.php", ProbePath: "actual-route", ExpectedText: "application route verified"})
			result := runApacheRewrite(context.Background(), env, input)
			shouldFail := mode == "rewrite-disabled" || mode == "wrong-route" || mode == "concurrent-edit"
			if result.IsError != shouldFail {
				t.Fatalf("unexpected result %+v", result)
			}
			got, _ := os.ReadFile(filepath.Join(root, ".htaccess"))
			expected := original
			if mode == "repair" {
				expected = apacheRewriteCandidate(original, "/app/", "index.php")
			}
			if mode == "concurrent-edit" {
				expected = "owner edit\n"
			}
			if string(got) != expected {
				t.Fatalf("wrong final .htaccess: %s", got)
			}
			probes, _ := filepath.Glob(filepath.Join(root, "mfagent-rewrite-*"))
			if len(probes) != 0 {
				t.Fatal("probe not cleaned")
			}
			journals, _ := filepath.Glob(filepath.Join(root, ".mfagent", "backups", "htaccess-operation-*"))
			if mode != "concurrent-edit" && len(journals) != 0 {
				t.Fatal("completed operation retains journal")
			}
		})
	}
}

func TestApacheInterruptedCheckRecovery(t *testing.T) {
	// A completed helper gives us an OS-confirmed dead owner, on every platform.
	child := exec.Command(os.Args[0], "-test.run=^$")
	if err := child.Run(); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"recover", "live-owner", "concurrent-edit", "corrupt-backup"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			env := &Env{Root: root}
			file := filepath.Join(root, ".htaccess")
			backup := filepath.Join(root, ".mfagent", "backups", "original.bak")
			probe := filepath.Join(root, "mfagent-rewrite-test.txt")
			writeFile(t, root, ".htaccess", "temporary rules")
			writeFile(t, root, ".mfagent/backups/original.bak", "original rules")
			writeFile(t, root, "mfagent-rewrite-test.txt", "token")
			pid := child.Process.Pid
			if mode == "live-owner" {
				pid = os.Getpid()
			}
			_, err := recordApacheRecovery(env, apacheRecovery{PID: pid, File: file, Backup: backup, Probe: probe, Existed: true, Mode: 0644, Hashes: []string{apacheHash([]byte("original rules")), apacheHash([]byte("temporary rules"))}})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "concurrent-edit" {
				writeFile(t, root, ".htaccess", "owner rules")
			}
			if mode == "corrupt-backup" {
				writeFile(t, root, ".mfagent/backups/original.bak", "other content")
			}
			err = recoverApacheRewrite(env, file)
			if mode == "recover" {
				if err != nil {
					t.Fatal(err)
				}
				got, _ := os.ReadFile(file)
				if string(got) != "original rules" {
					t.Fatal("original not recovered")
				}
				if _, err = os.Stat(probe); !os.IsNotExist(err) {
					t.Fatal("stale probe not removed")
				}
			} else if err == nil {
				t.Fatal("unsafe recovery accepted")
			}
		})
	}
}
