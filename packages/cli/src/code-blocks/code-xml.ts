import type { SemanticCodeBlock } from '../semantic/types.js';

export function renderCodeBlockXml(code: SemanticCodeBlock): string {
  if (code.issues.length > 0) {
    throw new Error(`Cannot render unsupported Code block: ${code.issues.map((issue) => issue.message).join('; ')}`);
  }
  const caption = code.caption === undefined ? '' : ` caption="${escapeAttribute(code.caption)}"`;
  return `<pre lang="${escapeAttribute(code.resolvedLanguage)}"${caption}><code>${escapeText(code.content)}</code></pre>`;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
