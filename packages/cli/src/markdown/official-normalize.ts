const ESCAPED_HTML_ENTITIES: Array<[RegExp, string]> = [
  [/\\&amp;/g, '&'],
  [/\\&lt;/g, '<'],
  [/\\&gt;/g, '>'],
  [/\\&quot;/g, '"'],
  [/\\&#34;/g, '"'],
  [/\\&\\#34;/g, '"'],
  [/\\&#39;/g, "'"],
  [/\\&\\#39;/g, "'"],
  [/\\&apos;/g, "'"]
];

const COMMONMARK_ESCAPED_PUNCTUATION = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{}~])/g;
const CANONICAL_CODE_LANGUAGES = new Set([
  'bash',
  'c',
  'cpp',
  'go',
  'java',
  'javascript',
  'json',
  'markdown',
  'python',
  'sql',
  'typescript',
  'yaml'
]);

export function normalizeOfficialMarkdownExport(markdown: string): string {
  const lines = normalizeSimpleHtmlTables(markdown.replace(/\r\n/g, '\n')).split('\n');
  let inFence = false;

  return lines.map((line) => {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      inFence = !inFence;
      return normalizeFenceLine(line, fence[1] ?? '');
    }
    if (inFence) return line;
    return decodeEscapedHtmlEntities(line).replace(COMMONMARK_ESCAPED_PUNCTUATION, '$1');
  }).join('\n');
}

function decodeEscapedHtmlEntities(value: string): string {
  return ESCAPED_HTML_ENTITIES.reduce((current, [pattern, replacement]) => {
    return current.replace(pattern, replacement);
  }, value);
}

function normalizeFenceLine(line: string, language: string): string {
  const normalized = language.toLowerCase();
  return CANONICAL_CODE_LANGUAGES.has(normalized) ? `\`\`\`${normalized}` : line;
}

function normalizeSimpleHtmlTables(markdown: string): string {
  return markdown.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) => {
    const table = parseSimpleHtmlTable(tableHtml);
    return table ? renderMarkdownTable(table) : tableHtml;
  });
}

function parseSimpleHtmlTable(tableHtml: string): string[][] | null {
  if (/\b(?:rowspan|colspan)\s*=/i.test(tableHtml)) return null;

  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
    const rowHtml = rowMatch[1];
    const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cellMatch) => {
      return normalizeTableCell(cellMatch[1]);
    });
    return cells;
  });

  if (rows.length === 0) return null;
  const width = rows[0].length;
  if (width === 0 || rows.some((row) => row.length !== width)) return null;
  return rows;
}

function normalizeTableCell(cellHtml: string): string {
  const inlineMarkdown = decodeEscapedHtmlEntities(cellHtml)
    .replace(/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, '**$1**')
    .replace(/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, '*$1*')
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return inlineMarkdown.replace(/\|/g, '\\|');
}

function renderMarkdownTable(rows: string[][]): string {
  const separator = rows[0].map(() => '---');
  return [rows[0], separator, ...rows.slice(1)]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
}
