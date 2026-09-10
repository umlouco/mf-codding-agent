package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileEditLineEndings(t *testing.T) {
	data, err := os.ReadFile("testdata/edit_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Text, Want, Error string
		Count                   int
		Edits                   []json.RawMessage
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "source.txt")
			if err := os.WriteFile(file, []byte(tc.Text), 0o644); err != nil {
				t.Fatal(err)
			}
			r := NewRegistry()
			RegisterFS(r)
			env := &Env{Root: root}
			read, _ := r.Get("read_file")
			res := read.Run(context.Background(), env, json.RawMessage(`{"path":"source.txt"}`))
			if res.IsError || strings.Contains(res.Output, "\r\n") {
				t.Fatalf("read_file should expose LF text: %+v", res)
			}
			name := "multi_edit"
			input := map[string]any{"path": "source.txt", "edits": tc.Edits}
			if len(tc.Edits) == 1 {
				name = "edit_file"
				if err := json.Unmarshal(tc.Edits[0], &input); err != nil {
					t.Fatal(err)
				}
			}
			raw, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			changed := 0
			env.FileChanged = func(string) { changed++ }
			edit, _ := r.Get(name)
			res = edit.Run(context.Background(), env, raw)
			want := tc.Want
			if tc.Error != "" {
				want = tc.Text
				if !res.IsError || !strings.Contains(res.Output, tc.Error) || changed != 0 {
					t.Fatalf("want error %q without notification, got %+v (changed=%d)", tc.Error, res, changed)
				}
				if len(tc.Edits) > 1 && !strings.Contains(res.Output, "edit 2/2 failed") {
					t.Fatalf("batch should fail only after preparing its first edit: %s", res.Output)
				}
			} else {
				count := fmt.Sprintf("%d replacement", tc.Count)
				if res.IsError || !strings.Contains(res.Output, count) || changed != 1 {
					t.Fatalf("want %s and notification, got %+v (changed=%d)", count, res, changed)
				}
			}
			got, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != want {
				t.Fatalf("file bytes = %q; want %q", got, want)
			}
		})
	}
}
