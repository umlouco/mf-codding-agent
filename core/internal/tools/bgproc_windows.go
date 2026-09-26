//go:build windows

package tools

import (
	"context"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

// prepareBackground hides the console window. The process tree is killed with
// taskkill /T, so no job object or process group is needed to reach children.
func prepareBackground(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// killTree kills the process and every descendant. Killing only the shell
// (Process.Kill) orphaned the real server — `python -m http.server` kept the
// port after its PowerShell parent died, and later runs found a stranger's app
// listening on it.
func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	killer := exec.CommandContext(ctx, "taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	killer.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := killer.Run(); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
