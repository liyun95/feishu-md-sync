export type PublishTransformProfile = 'milvus';

export type PublishTransformOptions = {
  profile?: PublishTransformProfile;
  linkBaseUrl?: string;
};

type Frontmatter = {
  title?: string;
  body: string;
};

const MILVUS_SHARED_NAME = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>';

export function applyPublishTransform(markdown: string, options: PublishTransformOptions = {}): string {
  let transformed = markdown;

  if (options.profile === 'milvus') {
    const frontmatter = stripFrontmatter(transformed);
    const withoutDuplicateTitle = dropDuplicateTitleHeading(frontmatter.body, frontmatter.title);
    transformed = transformProductNames(withoutDuplicateTitle);
  }

  if (options.linkBaseUrl) {
    transformed = rewriteRelativeLinks(transformed, options.linkBaseUrl);
  }

  return transformed;
}

function stripFrontmatter(markdown: string): Frontmatter {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { body: markdown };
  }

  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { body: markdown };
  }

  const rawFrontmatter = normalized.slice(4, end);
  const bodyStart = normalized[end + '\n---'.length] === '\n' ? end + '\n---\n'.length : end + '\n---'.length;
  return {
    title: frontmatterTitle(rawFrontmatter),
    body: normalized.slice(bodyStart).replace(/^\n+/, '')
  };
}

function frontmatterTitle(frontmatter: string): string | undefined {
  const match = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return match?.[1]?.trim();
}

function dropDuplicateTitleHeading(markdown: string, title: string | undefined): string {
  if (!title) return markdown;

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex === -1) return markdown;

  const heading = lines[firstContentIndex]?.match(/^#\s+(.+?)\s*$/);
  if (!heading || normalizeTitle(heading[1]) !== normalizeTitle(title)) {
    return markdown;
  }

  lines.splice(firstContentIndex, 1);
  while (lines[0] === '') {
    lines.shift();
  }
  return lines.join('\n');
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').toLowerCase();
}

function transformProductNames(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inCodeFence = false;

  return lines.map((line) => {
    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    return replaceOutsideProtectedSpans(line);
  }).join('\n');
}

function replaceOutsideProtectedSpans(line: string): string {
  const protectedSpans: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000${protectedSpans.length}\u0000`;
    protectedSpans.push(value);
    return token;
  };

  let transformed = line
    .replace(/<include\b[\s\S]*?<\/include>/g, protect)
    .replace(/`[^`]*`/g, protect)
    .replace(/\[[^\]]+\]\([^)]+\)/g, protect);

  transformed = transformed.replace(/\bMilvus(?:\s+\d+(?:\.\d+)*(?:\.x)?)?(?![-\w])/g, (match) => {
    return /\d/.test(match)
      ? `<include target="milvus">${match}</include>`
      : MILVUS_SHARED_NAME;
  });

  return transformed.replace(/\u0000(\d+)\u0000/g, (_, index: string) => protectedSpans[Number(index)] ?? '');
}

function rewriteRelativeLinks(markdown: string, baseUrl: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inCodeFence = false;

  return lines.map((line) => {
    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    return rewriteRelativeLinksInLine(line, baseUrl);
  }).join('\n');
}

function rewriteRelativeLinksInLine(line: string, baseUrl: string): string {
  const protectedSpans: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000${protectedSpans.length}\u0000`;
    protectedSpans.push(value);
    return token;
  };

  const protectedLine = line
    .replace(/<include\b[\s\S]*?<\/include>/g, protect)
    .replace(/`[^`]*`/g, protect);

  const rewritten = protectedLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, url: string) => {
    if (!shouldRewriteLink(url)) return match;
    return `[${label}](${new URL(url, baseUrl).toString()})`;
  });

  return rewritten.replace(/\u0000(\d+)\u0000/g, (_, index: string) => protectedSpans[Number(index)] ?? '');
}

function shouldRewriteLink(url: string): boolean {
  const trimmed = url.trim();
  return trimmed !== '' &&
    !trimmed.startsWith('#') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) &&
    !trimmed.startsWith('//');
}
