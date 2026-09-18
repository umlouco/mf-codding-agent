package agent

import (
	"bytes"
	"fmt"
	"sync"
)

/*
Degenerate replies.

The stream watcher in activity.go judges liveness from silence: a reply that
stops delivering bytes is dead, and a slow one that is still delivering is
working. That test is blind to the failure that actually wastes hours — a
quantised local model that never goes idle because it is producing bytes, but
is producing the same bytes over and over. Observed live: a worker streamed
"or License: GPL v2" for forty-nine minutes, 145 KB of model output, writing an
activity record every thirty seconds the whole time, so nothing in the queue
ever considered it stuck. It was not slow; it was done.

Silence cannot see that, so this adds the complementary evidence: a reply whose
tail is the same block repeated many times over has stopped making progress no
matter how many bytes arrive. The guard only reads the assistant's own text and
thinking — never tool arguments, which legitimately contain large generated
files — and only fires on thousands of consecutive identical bytes, so ordinary
repetition in prose, tables, or code does not trip it.
*/

const (
	// The longest tail of decoded model text examined for repetition. Long
	// enough to span many repetitions of a short loop, bounded so the check
	// stays cheap on a reply of any size.
	repetitionTailBytes = 32 * 1024
	// A repeated unit shorter than this is ordinary text (a run of separators,
	// indentation, a blank line). The loop that matters repeats a phrase or
	// block, not one character.
	repetitionMinUnit = 16
	// Repetition of a very long block still counts; this caps the search so a
	// normal reply pays only a bounded scan.
	repetitionMaxUnit = 4096
	// How many bytes of consecutive repetition are needed before the reply is
	// declared degenerate. Thousands of identical bytes do not occur in honest
	// output, and the observed loop crossed this within seconds of starting.
	repetitionMinBytes = 4096
	// How much new text accumulates before the tail is re-examined. The activity
	// tick is far coarser than this, and a degenerate reply can emit a lot of
	// nonsense in between ticks; a check this often keeps detection to seconds
	// on a slow local model without scanning on every single token.
	repetitionCheckStride = 512
)

// repetitionGuard accumulates the tail of a streaming reply and reports when it
// has collapsed into a repeated block. It is safe for concurrent use: the
// provider's read loop observes text while the activity ticker checks it.
type repetitionGuard struct {
	mu         sync.Mutex
	tail       []byte
	min        int
	sinceCheck int
	detail     string
}

func newRepetitionGuard(minBytes int) *repetitionGuard {
	if minBytes <= 0 {
		minBytes = repetitionMinBytes
	}
	return &repetitionGuard{tail: make([]byte, 0, repetitionTailBytes), min: minBytes}
}

// observe appends newly decoded model text, keeping only the most recent tail.
// It reports whether enough has arrived since the last look to be worth
// examining again.
func (g *repetitionGuard) observe(text string) bool {
	if text == "" {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.tail = append(g.tail, text...)
	if n := len(g.tail); n > repetitionTailBytes {
		copy(g.tail, g.tail[n-repetitionTailBytes:])
		g.tail = g.tail[:repetitionTailBytes]
	}
	g.sinceCheck += len(text)
	if g.sinceCheck < repetitionCheckStride {
		return false
	}
	g.sinceCheck = 0
	return true
}

// check reports whether the tail has become a repeated block, and why. The
// first positive result is remembered so every later caller sees the same
// reason even as more bytes arrive.
func (g *repetitionGuard) check() (bool, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.detail != "" {
		return true, g.detail
	}
	unit, repeats := findRepeatedSuffix(g.tail, g.min)
	if unit == 0 {
		return false, ""
	}
	g.detail = fmt.Sprintf(
		"the same %d-byte block repeated %d times in a row (%d bytes of identical output), "+
			"so the reply had stopped making progress",
		unit, repeats, unit*repeats)
	return true, g.detail
}

/*
findRepeatedSuffix finds whether the end of b is the same block repeated enough
times to reach minBytes.

It scans candidate block sizes from smallest to largest and, for each, walks
backwards comparing consecutive blocks to the final one. The first block size
that reaches the byte threshold wins. A reply that is not repeating breaks out
of each walk on the first mismatch, so the scan is proportional to the search
window rather than to the reply.
*/
func findRepeatedSuffix(b []byte, minBytes int) (unit, repeats int) {
	n := len(b)
	if minBytes < 2*repetitionMinUnit {
		minBytes = 2 * repetitionMinUnit
	}
	for size := repetitionMinUnit; size <= repetitionMaxUnit; size++ {
		if size*2 > n {
			break
		}
		last := b[n-size:]
		count := 1
		for {
			end := n - count*size
			start := end - size
			if start < 0 || !bytes.Equal(b[start:end], last) {
				break
			}
			count++
		}
		// count is 1 until a matching previous block is found, and one block on
		// its own is not a repetition — whatever its size.
		if count >= 2 && size*count >= minBytes {
			return size, count
		}
	}
	return 0, 0
}
