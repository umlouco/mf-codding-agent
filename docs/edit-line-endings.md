# Line-ending-safe file edits

`read_file` exposes LF-normalized text, even when disk uses CRLF. Previously,
copying a multiline block from that output into `edit_file` could fail with
`old_string not found (file uses CRLF line endings; match them or re-read the file)`.
Re-reading could not help because it normalized the line endings again.

Both edit backends now share these semantics:

- Match CRLF and LF as equivalent, with every other character still exact.
- Check uniqueness across all normalized matches, including mixed-EOL files.
- Map matches back to original offsets: bytes outside replacements are untouched
  by the matching logic, and single editor edits remain small native range edits.
- Normalize replacement newlines to the matched block's first EOL. If the block
  has no newline, use the file's first EOL; if neither has one, use LF.
- Reject empty searches and replacements identical after EOL normalization.
- Apply `multi_edit` sequentially and write nothing if any operation fails.

The Go fallback lives in `core/internal/tools/fs_edit.go`. The editor's single
and batch edit paths use `src/textEdits.ts`. Shared byte-exact fixtures in
`core/internal/tools/testdata/edit_cases.json` prevent backend drift.

## TDD verification

Before the fix, 16 of the initial 20 cases failed in **each** backend, including
the reported CRLF error. After implementation, all 20 passed. Six additional
safety cases cover empty/identical searches, LF-only files, non-overlapping
matches, batch ambiguity, and batch `replace_all`.

Run from the repository root:

```powershell
node --test scripts/editor-fs.test.cjs
node --test scripts/*.test.cjs
npm run typecheck
Push-Location core
go test ./...
Pop-Location
```

The Node regression suite invokes the registered `fs/edit` RPC handler using an
editor double that checks original ranges, save counts, and unchanged buffers
on failure. The Go suite calls `read_file`, then registered `edit_file` or
`multi_edit` against temporary files and checks their actual bytes. These tests
do not launch an interactive VS Code instance.
