import {
  DEFAULT_CODE_BLOCK_CONFIG,
  resolveCodeLanguage,
  type CodeBlockConfig
} from './code-language.js';

export type CodeBlockIssue = {
  code: 'unsupported-code-language' | 'unsupported-code-info-string';
  message: string;
};

export type FencedCodeMatch = {
  start: number;
  end: number;
  fenceMarker: '`' | '~';
  fenceLength: number;
  content: string;
  sourceLanguage: string;
  resolvedLanguage: string;
  issues: CodeBlockIssue[];
};

export function findNextFencedCode(
  markdown: string,
  from = 0,
  config: CodeBlockConfig = DEFAULT_CODE_BLOCK_CONFIG
): FencedCodeMatch | undefined {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const pattern = /(^|\n)( {0,3})(`{3,}|~{3,})([^\n]*)(?:\n|$)/g;
  pattern.lastIndex = from;
  const opening = pattern.exec(normalized);
  if (!opening) return undefined;

  const start = opening.index + (opening[1] ? 1 : 0);
  const fence = opening[3]!;
  const fenceMarker = fence[0] as '`' | '~';
  const fenceLength = fence.length;
  const openingLineEnd = normalized.indexOf('\n', start);
  const contentStart = openingLineEnd === -1 ? normalized.length : openingLineEnd + 1;
  const info = (opening[4] ?? '').trim();
  const issues: CodeBlockIssue[] = [];
  const infoTokens = info ? info.split(/\s+/) : [];
  if (infoTokens.length > 1 || (fenceMarker === '`' && info.includes('`'))) {
    issues.push({
      code: 'unsupported-code-info-string',
      message: `unsupported Code block info string: ${info}`
    });
  }
  const sourceLanguage = (infoTokens[0] ?? '').toLowerCase();
  let resolvedLanguage = sourceLanguage || 'plaintext';
  try {
    resolvedLanguage = resolveCodeLanguage(sourceLanguage, config).resolvedLanguage;
  } catch (error) {
    issues.push({
      code: 'unsupported-code-language',
      message: error instanceof Error ? error.message : String(error)
    });
  }

  let lineStart = contentStart;
  while (lineStart <= normalized.length) {
    const lineEnd = normalized.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? normalized.length : lineEnd;
    const line = normalized.slice(lineStart, end);
    const closing = line.match(/^( {0,3})(`+|~+)[ \t]*$/);
    if (closing && closing[2]?.[0] === fenceMarker && closing[2].length >= fenceLength) {
      return {
        start,
        end: lineEnd === -1 ? end : lineEnd + 1,
        fenceMarker,
        fenceLength,
        content: normalized.slice(contentStart, lineStart),
        sourceLanguage,
        resolvedLanguage,
        issues
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  issues.push({
    code: 'unsupported-code-info-string',
    message: 'unterminated fenced Code block'
  });
  return {
    start,
    end: normalized.length,
    fenceMarker,
    fenceLength,
    content: normalized.slice(contentStart),
    sourceLanguage,
    resolvedLanguage,
    issues
  };
}

export function renderFencedCode(input: { sourceLanguage: string; content: string }): string {
  return `\`\`\`${input.sourceLanguage}\n${input.content}${input.content.endsWith('\n') ? '' : '\n'}\`\`\``;
}

export function rewriteFencedCodeLanguages(
  markdown: string,
  languageFor: (match: FencedCodeMatch, index: number) => string
): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  let output = '';
  let cursor = 0;
  let index = 0;
  while (cursor < normalized.length) {
    const match = findNextFencedCode(normalized, cursor);
    if (!match) break;
    if (match.issues.some((issue) => issue.message === 'unterminated fenced Code block')) break;
    output += normalized.slice(cursor, match.start);
    output += renderFencedCode({ sourceLanguage: languageFor(match, index), content: match.content });
    if (normalized[match.end - 1] === '\n') output += '\n';
    cursor = match.end;
    index += 1;
  }
  return output + normalized.slice(cursor);
}

export function canonicalizeFencedCodeLanguages(
  markdown: string,
  config: CodeBlockConfig = DEFAULT_CODE_BLOCK_CONFIG
): string {
  return rewriteFencedCodeLanguages(markdown, (match) => {
    return resolveCodeLanguage(match.sourceLanguage, config).resolvedLanguage;
  });
}
