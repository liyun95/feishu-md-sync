import type { CalloutConfig } from '../config/sync-config.js';
import type { CalloutType } from '../semantic/types.js';
import { calloutTypeForTitle } from './callout-presentation.js';

export function canonicalizeRemoteCalloutMarkdown(input: {
  markdown: string;
  config: CalloutConfig;
  typeHints?: Array<CalloutType | undefined>;
  normalizeParagraphPayload?: boolean;
}): { markdown: string; warnings: string[] } {
  let index = 0;
  const warnings: string[] = [];
  const markdown = input.markdown.replace(/<callout\b[^>]*>([\s\S]*?)<\/callout>/gi, (_whole, rawBody: string) => {
    if (/<callout\b/i.test(rawBody)) throw new Error('Nested remote Callouts are unsupported.');
    const payload = calloutPayload(rawBody, input.normalizeParagraphPayload === true);
    const hintedType = input.typeHints?.[index];
    const calloutNumber = index + 1;
    index += 1;
    const type = hintedType ?? calloutTypeForTitle(payload.title, input.config);
    if (!type) throw new Error(`Cannot identify remote Callout type from title "${payload.title}".`);
    if (payload.paragraphWrapped) {
      warnings.push(
        `remote Callout ${calloutNumber} used paragraph-wrapped title/body compatibility normalization`
      );
    }
    return renderCanonicalCallout(type, payload.body);
  });
  return { markdown, warnings };
}

export function renderCanonicalCallout(type: CalloutType, body: string): string {
  return `<div class="alert ${type}">\n\n${body.trim()}\n\n</div>`;
}

function calloutPayload(rawBody: string, normalizeParagraphPayload: boolean): {
  title: string;
  body: string;
  paragraphWrapped: boolean;
} {
  const normalized = rawBody.replace(/\r\n/g, '\n');
  const paragraphs = normalizeParagraphPayload ? paragraphPayload(normalized) : undefined;
  if (paragraphs) {
    return {
      title: paragraphs[0]?.trim() ?? '',
      body: paragraphs.slice(1).map((paragraph) => paragraph.trim()).join('\n\n').trim(),
      paragraphWrapped: true
    };
  }
  const lines = normalized.split('\n');
  const titleIndex = lines.findIndex((line) => line.trim() !== '');
  return {
    title: titleIndex === -1 ? '' : (lines[titleIndex] ?? '').trim(),
    body: titleIndex === -1
      ? ''
      : [...lines.slice(0, titleIndex), ...lines.slice(titleIndex + 1)].join('\n').trim(),
    paragraphWrapped: false
  };
}

function paragraphPayload(value: string): string[] | undefined {
  const source = value.trim();
  if (!source.startsWith('<p') || !source.endsWith('</p>')) return undefined;
  const paragraphs: string[] = [];
  const pattern = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || source.slice(cursor, match.index).trim() !== '') return undefined;
    paragraphs.push(match[1] ?? '');
    cursor = match.index + match[0].length;
  }
  if (paragraphs.length === 0 || source.slice(cursor).trim() !== '') return undefined;
  return paragraphs;
}
