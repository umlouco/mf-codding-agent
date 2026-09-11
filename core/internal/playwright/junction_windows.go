//go:build windows

package playwright

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

// junction creates a directory junction, which unlike a symlink needs no
// elevation and no developer mode. Node resolves module paths through one the
// same way it does through a real directory.
func junction(from, to string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "cmd.exe", "/c", "mklink", "/J", to, from)
	configureCommand(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("mklink /J failed: %w: %s", err, tail(string(out), 400))
	}
	return nil
}
