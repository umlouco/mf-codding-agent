interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');

function firstEol(text: string): string | undefined {
  const i = text.indexOf('\n');
  return i < 0 ? undefined : i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/** Match the LF text exposed by read_file, but return original UTF-16 offsets
 * for VS Code. Only CRLF/LF are equivalent; other whitespace remains exact.
 * Keep in sync with core/internal/tools/fs_edit.go and the shared fixtures. */
export function matchEdits(text: string, oldStr: string, newStr: string, all: boolean): TextEdit[] {
  oldStr = normalizeEol(oldStr);
  newStr = normalizeEol(newStr);
  if (!oldStr) {
    throw new Error('old_string must not be empty');
  }
  if (oldStr === newStr) {
    throw new Error('old_string and new_string are identical');
  }
  const normalized = normalizeEol(text);
  const positions: number[] = [];
  for (let from = 0;;) {
    const i = normalized.indexOf(oldStr, from);
    if (i < 0) break;
    positions.push(i);
    from = i + oldStr.length;
  }
  if (positions.length === 0) {
    throw new Error('old_string not found; read_file the current file, then copy a smaller unique exact block without line numbers. For a deliberate full-file replacement, use write_file after reading it. No change was applied');
  }
  if (positions.length > 1 && !all) {
    throw new Error(`old_string appears ${positions.length} times; add surrounding context or set replace_all`);
  }

  // Matches are ordered and non-overlapping. Map boundaries in one forward
  // pass, without an offset table per character or normalizing untouched text.
  let rawOffset = 0, normalizedOffset = 0;
  const originalOffset = (offset: number): number => {
    while (normalizedOffset < offset) {
      rawOffset += text[rawOffset] === '\r' && text[rawOffset + 1] === '\n' ? 2 : 1;
      normalizedOffset++;
    }
    return rawOffset;
  };
  const fallbackEol = firstEol(text) ?? '\n';
  return positions.map(pos => {
    const start = originalOffset(pos);
    const end = originalOffset(pos + oldStr.length);
    // Prefer the matched block's style for mixed files; a single-line block
    // inherits the file's first EOL. Files without an EOL default to LF.
    const eol = firstEol(text.slice(start, end)) ?? fallbackEol;
    return { start, end, replacement: newStr.replace(/\n/g, eol) };
  });
}

/** Sequential multi_edit fold, using the same matches as native range edits. */
export function replaceIn(text: string, oldStr: string, newStr: string, all: boolean): { text: string; count: number } {
  const matches = matchEdits(text, oldStr, newStr, all);
  const parts: string[] = [];
  let end = 0;
  for (const match of matches) {
    parts.push(text.slice(end, match.start), match.replacement);
    end = match.end;
  }
  parts.push(text.slice(end));
  return { text: parts.join(''), count: matches.length };
}
