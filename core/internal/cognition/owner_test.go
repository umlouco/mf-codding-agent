package cognition

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestOwnerRunningCurrentProcess(t *testing.T) {
	alive, err := ownerRunning(os.Getpid())
	if err != nil || !alive {
		t.Fatalf("current process alive=%v err=%v", alive, err)
	}
}

func TestOwnerRunningRejectsInvalidPIDs(t *testing.T) {
	for _, pid := range []int{0, -1, -100} {
		alive, err := ownerRunning(pid)
		if alive || err == nil {
			t.Errorf("invalid pid %d alive=%v err=%v, want uncertainty error", pid, alive, err)
		}
	}
}

func TestOwnerRunningExitedProcess(t *testing.T) {
	const helperFlag = "MFAGENT_COGNITION_OWNER_HELPER"
	if os.Getenv(helperFlag) == "1" {
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestOwnerRunningExitedProcess$")
	cmd.Env = append(os.Environ(), helperFlag+"=1")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if err = cmd.Wait(); err != nil {
		t.Fatalf("wait for helper exit: %v", err)
	}
	// Waiting reaps the child on Unix and closes Go's process handle on
	// Windows. Existence is queried afresh, exactly as another core does.
	alive, err := ownerRunning(pid)
	if err != nil {
		t.Fatalf("query confirmed exited helper %d: %v", pid, err)
	}
	if alive {
		// The OS can reuse a PID between Wait and this lookup. Reporting it
		// alive is conservative and must never clear an uncertain operation.
		t.Skipf("helper pid %d is occupied after exit; conservatively retained", pid)
	}
}
