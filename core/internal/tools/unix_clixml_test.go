package tools

import "testing"

func TestUnixCliXmlPreservesCompilerFailureBesideProgress(t *testing.T) {
	const progress = `<Objs Version="1.1.0.1"><Obj S="progress"><PR><AV>Preparing modules for first use.</AV></PR></Obj></Objs>`
	const failure = "SyntaxError: ecrf-test.spec.js: Missing semicolon. (96:3)\nError: No tests found."
	for _, input := range []string{
		failure + "\n#< CLIXML\r\n" + progress,
		"#< CLIXML\r\n" + failure + "\n" + progress,
	} {
		if got := decodeCLIXML(input); got != failure+"\n" {
			t.Fatalf("compiler evidence was lost or progress XML leaked: %q", got)
		}
	}
	if got := decodeCLIXML("#< CLIXML\r\n" + progress); got != "" {
		t.Fatalf("progress-only stderr should be empty: %q", got)
	}
}

func TestUnixCliXmlPreservesPlainAndSerializedErrorStreams(t *testing.T) {
	const input = "native error\n#< CLIXML\n" +
		`<Objs Version="1.1.0.1"><S S="Error">check &lt;value&gt; failed_x000A_</S></Objs>`
	if got := decodeCLIXML(input); got != "native error\ncheck <value> failed\n" {
		t.Fatalf("decoded errors=%q", got)
	}
	for _, plain := range []string{"ordinary stderr\n", "", "#< CLIXML\n<Objs malformed"} {
		if got := decodeCLIXML(plain); got != plain {
			t.Fatalf("plain or malformed output changed: %q", got)
		}
	}
}
