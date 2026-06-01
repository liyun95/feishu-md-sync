export type MarkdownSection = {
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  markdown: string;
};

type HeadingMatch = {
  title: string;
  level: number;
  lineIndex: number;
};

export function extractUniqueMarkdownSection(markdown: string, sectionTitle: string): MarkdownSection {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headings = collectHeadings(lines);
  const normalizedTarget = normalizeHeading(sectionTitle);
  const matches = headings.filter((heading) => normalizeHeading(heading.title) === normalizedTarget);

  if (matches.length === 0) {
    throw new Error(`Could not find local section "${sectionTitle}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} local sections named "${sectionTitle}". Scoped push requires a unique heading.`);
  }

  const match = matches[0];
  let endLine = lines.length;
  for (const heading of headings) {
    if (heading.lineIndex > match.lineIndex && heading.level <= match.level) {
      endLine = heading.lineIndex;
      break;
    }
  }

  return {
    title: match.title,
    level: match.level,
    startLine: match.lineIndex,
    endLine,
    markdown: `${lines.slice(match.lineIndex, endLine).join('\n').replace(/\n*$/, '')}\n`
  };
}

function collectHeadings(lines: string[]): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  let inFence = false;

  lines.forEach((line, lineIndex) => {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) return;
    headings.push({
      level: match[1].length,
      title: stripHeadingAnchor(match[2]),
      lineIndex
    });
  });

  return headings;
}

function stripHeadingAnchor(value: string): string {
  return value.trim().replace(/\s*\{#[A-Za-z0-9_-]+\}\s*$/, '').trim();
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
