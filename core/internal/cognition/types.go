// Package cognition maintains the engineer's operational working memory from
// recorded execution, independently of model-authored recollections.
package cognition

import "encoding/json"

const PolicyVersion = 1

// Scope separates durable work from the replaceable model/process observing it.
type Scope struct {
	WorkID   string `json:"workId"`
	Observer string `json:"observer"`
	RunID    string `json:"runId"`
}

// Ticket identifies a persisted intent. Finish never invokes or retries a tool.
type Ticket struct {
	Scope
	ID                 string `json:"id"`
	OwnerPID           int    `json:"ownerPID,omitempty"`
	CallID             string `json:"callId"`
	Tool               string `json:"tool"`
	Action             string `json:"action"`
	Summary            string `json:"summary"`
	Mutating           bool   `json:"mutating"`
	ConcurrentMutation bool   `json:"concurrentMutation,omitempty"`
	Epoch              int64  `json:"epoch"`
	StartSeq           int64  `json:"startSeq"`
}

// Event is the replay protocol. Payloads contain hashes and bounded excerpts,
// never full tool inputs/outputs. Sequence, not wall time, orders decisions.
type Event struct {
	Version            int     `json:"version"`
	Seq                int64   `json:"seq"`
	Kind               string  `json:"kind"` // run, start, finish, sync, orphan, gap
	Scope              Scope   `json:"scope"`
	Epoch              int64   `json:"epoch"`
	Ticket             *Ticket `json:"ticket,omitempty"`
	Digest             string  `json:"digest,omitempty"`
	Excerpt            string  `json:"excerpt,omitempty"`
	IsError            bool    `json:"isError,omitempty"`
	Unknown            bool    `json:"unknown,omitempty"`
	StateHash          string  `json:"stateHash,omitempty"`
	ConcurrentMutation bool    `json:"concurrentMutation,omitempty"`
}

type Evidence struct {
	Action       string `json:"action"`
	Observer     string `json:"observer"`
	RunID        string `json:"runId"`
	Tool         string `json:"tool"`
	Summary      string `json:"summary"`
	Digest       string `json:"digest"`
	Excerpt      string `json:"excerpt"`
	FirstSeq     int64  `json:"firstSeq"`
	LastSeq      int64  `json:"lastSeq"`
	Epoch        int64  `json:"epoch"`
	IsError      bool   `json:"isError"`
	Unknown      bool   `json:"unknown"`
	Mutating     bool   `json:"mutating"`
	Overlapped   bool   `json:"overlapped"`
	Repeats      int    `json:"repeats"`
	Observations int    `json:"observations"`
	FailureSeq   int64  `json:"failureSeq,omitempty"`
	RecoverySeq  int64  `json:"recoverySeq,omitempty"`
}

type Interrupted struct {
	Ticket Ticket `json:"ticket"`
	Seq    int64  `json:"seq"`
}

type State struct {
	Version          int                 `json:"version"`
	Seq              int64               `json:"seq"`
	Epoch            int64               `json:"epoch"`
	Runs             map[string]string   `json:"runs"`
	Pending          map[string]Ticket   `json:"pending"`
	Evidence         map[string]Evidence `json:"evidence"`
	Interrupted      []Interrupted       `json:"interrupted"`
	OmittedEvidence  int                 `json:"omittedEvidence"`
	OmittedFailures  int                 `json:"omittedFailures"`
	OmittedUncertain int                 `json:"omittedUncertain"`
	LastGapSeq       int64               `json:"lastGapSeq,omitempty"`
}

// Focus carries the rule and the exact journal records that caused attention.
// A priority is an ordered engineering obligation, not a confidence score.
type Focus struct {
	Rule     string  `json:"rule"`
	Priority int     `json:"priority"`
	Action   string  `json:"action,omitempty"`
	Evidence []int64 `json:"evidence"`
	Detail   string  `json:"detail"`
}

type Snapshot struct {
	Version  int     `json:"version"`
	WorkID   string  `json:"workId"`
	Observer string  `json:"observer"`
	Seq      int64   `json:"seq"`
	Epoch    int64   `json:"epoch"`
	Focus    []Focus `json:"focus"`
	Omitted  int     `json:"omitted"`
	Summary  string  `json:"summary"`
}

type Outcome struct {
	Output   string
	IsError  bool
	ExitCode *int
}

// Journal is the runtime integration boundary. Implemented by Store; tests can
// use a real temporary database without calling a model or external service.
type Journal interface {
	StartRun(Scope) (Snapshot, error)
	Begin(Scope, string, string, json.RawMessage, bool) (Ticket, error)
	Finish(Ticket, Outcome) (Snapshot, error)
	RecordGap(Scope) (Snapshot, error)
	View(Scope) (Snapshot, error)
}
