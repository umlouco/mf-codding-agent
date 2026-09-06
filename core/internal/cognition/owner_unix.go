//go:build !windows

package cognition

import (
	"errors"
	"fmt"
	"math"
	"syscall"
)

// Signal zero checks existence without delivering a signal or stopping work.
// EPERM is uncertainty, not evidence that the owner exited. A reused PID or an
// unreaped process conservatively retains the operation as active.
func ownerRunning(pid int) (bool, error) {
	if pid <= 0 || uint64(pid) > math.MaxInt32 {
		return false, fmt.Errorf("invalid owner process id %d", pid)
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	return false, fmt.Errorf("query owner process %d: %w", pid, err)
}
