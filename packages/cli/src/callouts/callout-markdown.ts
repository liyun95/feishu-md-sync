import type { CalloutConfig } from '../config/sync-config.js';
import type { CalloutType } from '../semantic/types.js';
import { calloutTypeForTitle } from './callout-presentation.js';

export function canonicalizeRemoteCalloutMarkdown(input: {
  markdown: string;
  config: CalloutConfig;
  typeHints?: Array<CalloutType | undefined>;
}): { markdown: string; warnings: string[] } {
  let index = 0;
  const markdown = input.markdown.replace(/<callout\b[^>]*>([\s\S]*?)<\/callout>/gi, (_whole, rawBody: string) => {
    if (/<callout\b/i.test(rawBody)) throw new Error('Nested remote Callouts are unsupported.');
    const lines = rawBody.replace(/\r\n/g, '\n').split('\n');
    const titleIndex = lines.findIndex((line) => line.trim() !== '');
    const title = titleIndex === -1 ? '' : (lines[titleIndex] ?? '').trim();
    const hintedType = input.typeHints?.[index];
    index += 1;
    const type = hintedType ?? calloutTypeForTitle(title, input.config);
    if (!type) throw new Error(`Cannot identify remote Callout type from title "${title}".`);
    const body = titleIndex === -1
      ? ''
      : [...lines.slice(0, titleIndex), ...lines.slice(titleIndex + 1)].join('\n').trim();
    return renderCanonicalCallout(type, body);
  });
  return { markdown, warnings: [] };
}

export function renderCanonicalCallout(type: CalloutType, body: string): string {
  return `<div class="alert ${type}">\n\n${body.trim()}\n\n</div>`;
}
