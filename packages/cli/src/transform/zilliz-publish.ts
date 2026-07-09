import { dualProductName, milvusOnly, protectInlineSpans } from './include-tags.js';

export type PublishTransformResult = {
  markdown: string;
  warnings: string[];
};

const VERSIONED_MILVUS_PATTERN = /\bMilvus\s+v?\d+(?:\.\d+)*(?:\.x)?\b/;
const ORDINARY_MILVUS_PATTERN = /\bMilvus(?!\s+v?\d)(?![-\w])/g;

export function applyZillizPublishTransform(markdown: string): PublishTransformResult {
  const warnings: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inCodeFence = false;

  const transformed = lines.map((line) => {
    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    if (/^#{1,6}\s+/.test(line)) {
      if (/\bMilvus\b/.test(line)) warnings.push(`Heading contains Milvus product wording and was not rewritten: ${line}`);
      return line;
    }
    return transformLine(line);
  }).join('\n');

  return { markdown: transformed, warnings };
}

function transformLine(line: string): string {
  if (line.trim() === '') return line;

  const { protectedLine, restore } = protectInlineSpans(line);
  const transformed = transformSentences(protectedLine);
  return restore(transformed);
}

function transformSentences(line: string): string {
  return line
    .split(/(?<=[.!?])(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return part;
      if (VERSIONED_MILVUS_PATTERN.test(part)) return milvusOnly(part);
      return part.replace(ORDINARY_MILVUS_PATTERN, dualProductName());
    })
    .join('');
}
