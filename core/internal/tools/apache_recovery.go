package tools

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mflores/mfagent/core/internal/cognition"
)

type apacheRecovery struct {
	PID     int      `json:"pid"`
	File    string   `json:"file"`
	Backup  string   `json:"backup"`
	Probe   string   `json:"probe"`
	Existed bool     `json:"existed"`
	Mode    uint32   `json:"mode"`
	Hashes  []string `json:"hashes"`
}

func apacheHash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func apacheRecoveryPath(env *Env, file string) (string, error) {
	return env.Resolve(filepath.Join(".mfagent", "backups", "htaccess-operation-"+apacheHash([]byte(file))[:20]+".json"))
}

func recoverApacheRewrite(env *Env, file string) error {
	journal, err := apacheRecoveryPath(env, file)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(journal)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var prior apacheRecovery
	if json.Unmarshal(data, &prior) != nil || prior.File != file {
		return fmt.Errorf("invalid Apache recovery record: %s", journal)
	}
	alive, err := cognition.ProcessRunning(prior.PID)
	if err != nil || alive {
		return fmt.Errorf("another Apache check owns this .htaccess (PID %d); its absence has not been established", prior.PID)
	}
	backup, err := env.Resolve(prior.Backup)
	if err != nil {
		return err
	}
	probe, err := env.Resolve(prior.Probe)
	if err != nil {
		return err
	}
	sameDirectory, relErr := filepath.Rel(filepath.Dir(resolveExisting(file)), filepath.Dir(probe))
	if relErr != nil || sameDirectory != "." || !strings.HasPrefix(filepath.Base(probe), "mfagent-rewrite-") || !strings.HasSuffix(probe, ".txt") {
		return fmt.Errorf("invalid recovery probe path")
	}
	original, err := os.ReadFile(backup)
	if err != nil {
		return fmt.Errorf("read recovery backup: %w", err)
	}
	if len(prior.Hashes) == 0 || apacheHash(original) != prior.Hashes[0] {
		return fmt.Errorf("Apache recovery backup does not match the original hash")
	}
	current, err := os.ReadFile(file)
	if err != nil && !(os.IsNotExist(err) && !prior.Existed) {
		return err
	}
	known := false
	for _, hash := range prior.Hashes {
		if hash == apacheHash(current) {
			known = true
			break
		}
	}
	if !known {
		return fmt.Errorf(".htaccess changed after the interrupted probe; refusing to overwrite it. Original backup: %s", backup)
	}
	if prior.Existed {
		err = os.WriteFile(file, original, os.FileMode(prior.Mode))
	} else {
		err = os.Remove(file)
		if os.IsNotExist(err) {
			err = nil
		}
	}
	if err != nil {
		return fmt.Errorf("restore interrupted .htaccess check: %w", err)
	}
	if err = os.Remove(probe); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Remove(journal)
}

func recordApacheRecovery(env *Env, operation apacheRecovery) (string, error) {
	journal, err := apacheRecoveryPath(env, operation.File)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(operation)
	if err != nil {
		return "", err
	}
	f, err := os.OpenFile(journal, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", fmt.Errorf("another rewrite check acquired this file: %w", err)
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(journal)
		return "", err
	}
	return journal, nil
}
