package agent

import (
	"bytes"
	"strings"
	"testing"
)

// The live failure this guard exists for: a model that stayed busy for
// forty-nine minutes emitting the same license line and never finished.
func TestRepetitionGuardCatchesObservedDegenerateReply(t *testing.T) {
	guard := newRepetitionGuard(repetitionMinBytes)
	unit := "or License: GPL v2 "
	for i := 0; i < 600; i++ {
		guard.observe(unit)
	}
	bad, detail := guard.check()
	if !bad {
		t.Fatalf("expected the repeated reply to be reported as degenerate")
	}
	if !strings.Contains(detail, "repeated") {
		t.Fatalf("detail should explain the repetition, got %q", detail)
	}
	// The reason is stable once found, even as more text arrives.
	guard.observe(unit)
	again, same := guard.check()
	if !again || same != detail {
		t.Fatalf("later checks should keep the original reason, got %q", same)
	}
}

// Ordinary prose, code and whitespace must never trip it.
func TestRepetitionGuardAcceptsOrdinaryText(t *testing.T) {
	guard := newRepetitionGuard(repetitionMinBytes)
	var b strings.Builder
	for i := 0; i < 2000; i++ {
		// Each line is distinct: real prose is not the same bytes re-emitted.
		b.WriteString("Step ")
		b.WriteString(strings.Repeat("x", i%97))
		b.WriteString(" inspected revision ")
		b.WriteString(strings.Repeat("y", i%53))
		b.WriteString(" and corrected the failing assertion.\n")
	}
	guard.observe(b.String())
	if bad, detail := guard.check(); bad {
		t.Fatalf("ordinary text must not be degenerate: %s", detail)
	}
}

// A short run of a separator is repetition, but not thousands of identical
// bytes, and must be tolerated.
func TestRepetitionGuardAcceptsShortRepeatedRun(t *testing.T) {
	guard := newRepetitionGuard(repetitionMinBytes)
	guard.observe(strings.Repeat("-", 200))
	if bad, detail := guard.check(); bad {
		t.Fatalf("a short repeated run must not be degenerate: %s", detail)
	}
}

// The scan walks backwards over the tail, so a block repeated with varied text
// in front is still caught, and the reported unit is the real period.
func TestFindRepeatedSuffixReportsPeriod(t *testing.T) {
	b := append([]byte("varied opening text that is not part of the loop. "),
		bytes.Repeat([]byte("ABCDEFGHIJKLMNOPQRST"), 500)...)
	unit, repeats := findRepeatedSuffix(b, repetitionMinBytes)
	if unit != len("ABCDEFGHIJKLMNOPQRST") {
		t.Fatalf("expected the real period %d, got %d", len("ABCDEFGHIJKLMNOPQRST"), unit)
	}
	if repeats < 400 {
		t.Fatalf("expected hundreds of repeats, got %d", repeats)
	}
}

// One long block is not a repetition, however large it is. A size-only check
// would call any tail at least minBytes long degenerate.
func TestFindRepeatedSuffixIgnoresSingleLargeBlock(t *testing.T) {
	b := make([]byte, repetitionMinBytes*2)
	seed := uint64(0x9E3779B97F4A7C15)
	for i := range b {
		seed ^= seed << 13
		seed ^= seed >> 7
		seed ^= seed << 17
		b[i] = byte(seed)
	}
	if unit, repeats := findRepeatedSuffix(b, repetitionMinBytes); unit != 0 {
		t.Fatalf("a single non-repeating block must not count, got unit %d x%d", unit, repeats)
	}
}

func TestFindRepeatedSuffixIgnoresShortInput(t *testing.T) {
	if unit, _ := findRepeatedSuffix([]byte("short"), repetitionMinBytes); unit != 0 {
		t.Fatalf("short input cannot contain a degenerate tail, got unit %d", unit)
	}
}
