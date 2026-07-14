export type MarkdownImageReference = {
  alt: string;
  source: string;
};

export type MarkdownImageSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'image'; alt: string; source: string }
  | { kind: 'inline-image'; content: string; images: MarkdownImageReference[] };

const STANDALONE_IMAGE = /^\s*!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)\s*$/;
const INLINE_IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;

export function splitMarkdownImageBlocks(markdown: string): MarkdownImageSegment[] {
  const segments: MarkdownImageSegment[] = [];
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let buffer = '';
  let fence: { marker: '`' | '~'; length: number } | undefined;

  const flush = (): void => {
    if (!buffer) return;
    segments.push({ kind: 'markdown', content: buffer });
    buffer = '';
  };

  for (const line of lines) {
    const body = line.endsWith('\n') ? line.slice(0, -1) : line;
    const fenceMatch = body.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      buffer += line;
      if (fenceMatch?.[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = {
        marker: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length
      };
      buffer += line;
      continue;
    }

    const standalone = parseStandaloneImage(body);
    if (standalone) {
      flush();
      segments.push({ kind: 'image', ...standalone });
      continue;
    }

    const images = parseInlineImages(body);
    if (images.length > 0) {
      flush();
      segments.push({ kind: 'inline-image', content: line, images });
      continue;
    }
    buffer += line;
  }

  flush();
  return segments;
}

function parseStandaloneImage(line: string): MarkdownImageReference | undefined {
  const match = line.match(STANDALONE_IMAGE);
  if (!match) return undefined;
  return {
    alt: match[1] ?? '',
    source: match[2] ?? match[3] ?? ''
  };
}

function parseInlineImages(line: string): MarkdownImageReference[] {
  return [...line.matchAll(INLINE_IMAGE)].map((match) => ({
    alt: match[1] ?? '',
    source: match[2] ?? match[3] ?? ''
  }));
}
