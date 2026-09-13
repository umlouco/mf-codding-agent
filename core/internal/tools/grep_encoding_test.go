package tools

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func encodeUTF16(text string, order binary.ByteOrder, bom []byte) []byte {
	out := append([]byte{}, bom...)
	for _, unit := range utf16.Encode([]rune(text)) {
		var b [2]byte
		order.PutUint16(b[:], unit)
		out = append(out, b[:]...)
	}
	return out
}

// The Windows builtin runs where the host has no grep (see preferHostUtil).
// MFAGENT_PORTABLE_UTILS makes the test exercise it on every platform too.
func TestPortableGrepReadsUTF16(t *testing.T) {
	t.Setenv("MFAGENT_PORTABLE_UTILS", "1")
	root := t.TempDir()
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("le.txt", encodeUTF16("alpha line\r\nbeta line\r\n", binary.LittleEndian, []byte{0xFF, 0xFE}))
	write("be.txt", encodeUTF16("alpha line\r\nbeta line\r\n", binary.BigEndian, []byte{0xFE, 0xFF}))

	env := &Env{Root: root}
	for _, name := range []string{"le.txt", "be.txt"} {
		out, status, err := RunScript(context.Background(), env, root, "grep -a beta "+name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if status != 0 || !strings.Contains(out, "beta line") {
			t.Fatalf("%s: UTF-16 text should match with -a: status=%d output=%q", name, status, out)
		}
	}
}

func TestPortableGrepTextAndIgnoreBinary(t *testing.T) {
	t.Setenv("MFAGENT_PORTABLE_UTILS", "1")
	root := t.TempDir()
	blob := append([]byte{0x00}, []byte("needle")...)
	blob = append(blob, 0x00, '\n')
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
	env := &Env{Root: root}

	out, status, err := RunScript(context.Background(), env, root, "grep -a needle blob.bin")
	if err != nil || status != 0 || !strings.Contains(out, "needle") {
		t.Fatalf("grep -a should read a binary file as text: status=%d err=%v output=%q", status, err, out)
	}

	out, status, err = RunScript(context.Background(), env, root, "grep -I needle blob.bin")
	if err != nil {
		t.Fatal(err)
	}
	if status != 1 || strings.TrimSpace(out) != "" {
		t.Fatalf("grep -I should skip a binary file with no match status: status=%d output=%q", status, out)
	}

	out, _, _ = RunScript(context.Background(), env, root, "grep -z needle blob.bin")
	if !strings.Contains(out, "unsupported grep option -z") {
		t.Fatalf("an unsupported option should still be refused with usage: %q", out)
	}
}

func TestGrepToolReadsUTF16(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(root, "log.txt"),
		encodeUTF16("first\r\nERROR: failed\r\n", binary.LittleEndian, []byte{0xFF, 0xFE}),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	RegisterSearch(registry)
	grep, ok := registry.Get("grep")
	if !ok {
		t.Fatal("grep tool is not registered")
	}
	res := grep.Run(context.Background(), &Env{Root: root}, json.RawMessage(`{"pattern":"ERROR"}`))
	if res.IsError || !strings.Contains(res.Output, "ERROR: failed") {
		t.Fatalf("grep tool should decode UTF-16 instead of skipping it: %+v", res)
	}
}
