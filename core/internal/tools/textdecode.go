package tools

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"io"
	"strings"
	"unicode/utf16"
)

// textReader normalises the text encodings a Windows workspace hands to the
// search and shell tools.
//
// On Linux and macOS the shell delegates grep (and the other read-only text
// utilities) to the host, which understands a UTF-16 BOM, so this never came
// up. On Windows there is no grep to delegate to, the Go builtin runs instead
// (see preferHostUtil), and it saw UTF-16 as a binary blob: PowerShell
// transcripts, some application logs and saved configuration interleave NUL
// bytes with ASCII, so an ASCII pattern could never match and the model was
// left converting files by hand. The builtin has to do what the host utility
// would have done.
//
// A BOM-marked UTF-16 stream is decoded to UTF-8; a UTF-8 BOM is stripped
// because grep treats it as an encoding marker rather than data. Everything
// else is returned untouched, so ordinary binary files keep behaving as they
// did and the caller decides with -I whether to skip them.
func textReader(r io.Reader) io.Reader {
	br := bufio.NewReader(r)
	head, _ := br.Peek(3)
	if len(head) < 2 {
		return br
	}
	var order binary.ByteOrder
	switch {
	case head[0] == 0xFF && head[1] == 0xFE:
		order = binary.LittleEndian
	case head[0] == 0xFE && head[1] == 0xFF:
		order = binary.BigEndian
	}
	if order != nil {
		data, err := io.ReadAll(br)
		if err != nil {
			return bytes.NewReader(data)
		}
		return strings.NewReader(decodeUTF16(data, order))
	}
	if head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF {
		_, _ = br.Discard(3)
	}
	return br
}

// decodeUTF16 converts a BOM-prefixed (or already-stripped) UTF-16 byte stream
// to UTF-8. Surrogate pairs are reassembled by utf16.Decode; an odd trailing
// byte is dropped with the same "bytes did not form a whole unit" tolerance
// grep shows for a truncated file.
func decodeUTF16(data []byte, order binary.ByteOrder) string {
	if len(data) >= 2 && ((data[0] == 0xFF && data[1] == 0xFE) || (data[0] == 0xFE && data[1] == 0xFF)) {
		data = data[2:]
	}
	units := make([]uint16, 0, len(data)/2)
	for i := 0; i+1 < len(data); i += 2 {
		units = append(units, order.Uint16(data[i:i+2]))
	}
	return string(utf16.Decode(units))
}
