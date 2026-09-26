//go:build !windows

package tools

import (
	"os/exec"
	"syscall"
)

// prepareBackground puts the command in its own process group so killTree can
// reach every descendant, not just the /bin/sh wrapper.
func prepareBackground(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		return cmd.Process.Kill()
	}
	return nil
}
