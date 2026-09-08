package queue

// TaskStatus is the closed set of states a task can be in.
type TaskStatus string

const (
	StatusPending   TaskStatus = "PENDING"
	StatusExecuting TaskStatus = "EXECUTING"
	StatusVerifying TaskStatus = "VERIFYING"
	StatusVerified  TaskStatus = "VERIFIED"
	// StatusFailed is legacy input only; storage converts it to decomposition work.
	StatusFailed TaskStatus = "FAILED"
	StatusPaused TaskStatus = "PAUSED"
)

// RunState tracks the queue's overall execution state.
type RunState string

const (
	RunIdle    RunState = "IDLE"
	RunRunning RunState = "RUNNING"
	RunPaused  RunState = "PAUSED"
	RunStopped RunState = "STOPPED"
)

// Task is a single row in the tasks table.
type Task struct {
	ID                    int64      `json:"id"`
	Title                 string     `json:"title"`
	Description           string     `json:"description"`
	ImplVerifyPrompt      string     `json:"implVerifyPrompt"`
	SolutionVerifyPrompt  string     `json:"solutionVerifyPrompt"`
	SolutionVerifyCommand string     `json:"solutionVerifyCommand"`
	Status                TaskStatus `json:"status"`
	Seq                   int        `json:"seq"`
	Output                string     `json:"output"`
	ValidationReport      string     `json:"validationReport"`
	ErrorLog              string     `json:"errorLog"`
	SupervisorFeedback    string     `json:"supervisorFeedback"`
	Attempts              int        `json:"attempts"`
	MaxAttempts           int        `json:"maxAttempts"`
	LastActivityAt        *int64     `json:"lastActivityAt"`
	ActivityPhase         string     `json:"activityPhase"`
	ActivityDetail        string     `json:"activityDetail"`
	TokensIn              int64      `json:"tokensIn"`
	TokensOut             int64      `json:"tokensOut"`
	TokensCacheRead       int64      `json:"tokensCacheRead"`
	TokensCacheWrite      int64      `json:"tokensCacheWrite"`
	CreatedAt             int64      `json:"createdAt"`
	UpdatedAt             int64      `json:"updatedAt"`
	StartedAt             *int64     `json:"startedAt"`
	FinishedAt            *int64     `json:"finishedAt"`
	// Kind is "task" (the default) or "phase" — a phase is a coarse slice of
	// the plan awaiting expansion into real tasks by the extension's queue
	// orchestrator, not something this server creates. It is mirrored here
	// purely so a client listing tasks sees what a row actually is instead of
	// a "task" with no verify prompts and no explanation why.
	Kind string `json:"kind"`
	// Region is set only on phase rows: JSON describing the workspace slice
	// (paths + file count) the expansion agent was bounded to.
	Region string `json:"region"`
}

// Usage holds token counts aggregated across tasks.
type Usage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// QueueStats is the summary returned by Stats().
type QueueStats struct {
	Total    int                `json:"total"`
	ByStatus map[TaskStatus]int `json:"byStatus"`
	RunState RunState           `json:"runState"`
	Usage    Usage              `json:"usage"`
}

// NewTask holds the fields accepted when creating a task.
type NewTask struct {
	Title                 string
	Description           string
	ImplVerifyPrompt      string
	SolutionVerifyPrompt  string
	SolutionVerifyCommand string
	Seq                   int
	MaxAttempts           int
	Status                TaskStatus
}
