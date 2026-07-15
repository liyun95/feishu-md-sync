export type SourceRange = {
  start: number;
  end: number;
};

export function protectedCodeRanges(markdown: string): SourceRange[] {
  const lines = lineSlices(markdown);
  const ranges: SourceRange[] = [];
  let fence: { marker: '`' | '~'; length: number; start: number } | undefined;
  let indentedStart: number | undefined;

  for (const line of lines) {
    const body = line.text.replace(/\r?\n$/, '');
    const fenceMatch = body.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch?.[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length) {
        ranges.push({ start: fence.start, end: line.end });
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      if (indentedStart !== undefined) {
        ranges.push({ start: indentedStart, end: line.start });
        indentedStart = undefined;
      }
      fence = {
        marker: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
        start: line.start
      };
      continue;
    }

    const indented = /^(?: {4}|\t)/.test(body);
    if (indented && indentedStart === undefined) indentedStart = line.start;
    if (!indented && body.trim() !== '' && indentedStart !== undefined) {
      ranges.push({ start: indentedStart, end: line.start });
      indentedStart = undefined;
    }
  }

  if (fence) ranges.push({ start: fence.start, end: markdown.length });
  if (indentedStart !== undefined) ranges.push({ start: indentedStart, end: markdown.length });
  return ranges;
}

export function isProtectedOffset(offset: number, ranges: SourceRange[]): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

export function lineAndColumnAt(markdown: string, offset: number): { line: number; column: number } {
  const before = markdown.slice(0, Math.max(0, offset));
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1
  };
}

function lineSlices(markdown: string): Array<{ text: string; start: number; end: number }> {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  return lines.map((text) => {
    const start = offset;
    offset += text.length;
    return { text, start, end: offset };
  });
}
