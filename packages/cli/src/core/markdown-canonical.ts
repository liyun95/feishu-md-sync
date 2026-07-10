import { hashText } from '../receipts/publish-receipt.js';

export function canonicalMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function canonicalMarkdownHash(markdown: string): string {
  return hashText(canonicalMarkdown(markdown));
}
