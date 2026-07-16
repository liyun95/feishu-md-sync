import { protectedCodeRanges } from '../dialects/source-lines.js';

export function canonicalizeMarkdownSemantics(markdown: string): string {
  const ranges = protectedCodeRanges(markdown);
  const output: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    output.push(canonicalizeUnprotected(markdown.slice(cursor, range.start)));
    output.push(markdown.slice(range.start, range.end));
    cursor = range.end;
  }
  output.push(canonicalizeUnprotected(markdown.slice(cursor)));
  return output.join('');
}

function canonicalizeUnprotected(markdown: string): string {
  return markdown
    .replace(/[^\n]*\n|[^\n]+$/g, (line) => canonicalizeLine(line))
    .replace(/\u00a0/g, ' ');
}

function canonicalizeLine(line: string): string {
  const body = line.replace(/\r?\n$/, '');
  const newline = line.slice(body.length);
  const separator = canonicalTableSeparator(body);
  if (separator !== undefined) return `${separator}${newline}`;
  return `${body.replace(/^(\s*)\d+[.)](\s+)/, '$11.$2')}${newline}`;
}

function canonicalTableSeparator(line: string): string | undefined {
  const indent = line.match(/^\s*/)?.[0] ?? '';
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return undefined;
  const rawCells = trimmed.split('|');
  if (rawCells[0] === '') rawCells.shift();
  if (rawCells.at(-1) === '') rawCells.pop();
  const cells = rawCells.map((cell) => cell.trim());
  if (cells.length === 0 || cells.some((cell) => !/^:?-+:?$/.test(cell))) {
    return undefined;
  }
  const normalized = cells.map((cell) => {
    const left = cell.startsWith(':') ? ':' : '';
    const right = cell.endsWith(':') ? ':' : '';
    return `${left}---${right}`;
  });
  return `${indent}| ${normalized.join(' | ')} |`;
}
