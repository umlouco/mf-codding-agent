//go:build windows

package cognition

import (
	"errors"
	"fmt"
	"math"

	"golang.org/x/sys/windows"
)

// ownerRunning only concludes that an owner is gone when the operating system
// establishes absence or termination. Permission failures retain uncertainty.
// A reused PID may conservatively retain an old operation as active.
func ownerRunning(pid int) (bool, error) {
	if pid <= 0 || uint64(pid) > math.MaxUint32 {
		return false, fmt.Errorf("invalid owner process id %d", pid)
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// OpenProcess reports ERROR_INVALID_PARAMETER for a PID that no
		// longer exists. PID zero is excluded above; access denial differs.
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return false, nil
		}
		return false, fmt.Errorf("query owner process %d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)
	var status uint32
	if err := windows.GetExitCodeProcess(handle, &status); err != nil {
		return false, fmt.Errorf("read owner process %d status: %w", pid, err)
	}
	const stillActive = 259
	return status == stillActive, nil
}
