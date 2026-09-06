package cognition

// ProcessRunning exposes the same conservative OS ownership check used by the
// runtime journal to recover other interrupted workspace operations.
func ProcessRunning(pid int) (bool, error) { return ownerRunning(pid) }
