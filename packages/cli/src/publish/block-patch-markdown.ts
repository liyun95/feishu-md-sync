export function markdownBodyForBlockPatch(
  publishDraft: string,
  remoteMarkdown: string,
  documentTitle?: string
): string {
  const publishTitle = leadingH1Title(publishDraft);
  if (!publishTitle) return publishDraft;
  const remoteTitle = leadingH1Title(remoteMarkdown);
  const explicitTitleMatches = documentTitle?.trim() === publishTitle;
  if (remoteTitle !== publishTitle && !explicitTitleMatches) return publishDraft;
  return stripLeadingH1(publishDraft);
}

function leadingH1Title(markdown: string): string | undefined {
  const { body } = splitLeadingFrontmatter(markdown);
  const match = body.match(/^#\s+(.+?)(?:\n|$)/);
  return match?.[1]?.trim();
}

function stripLeadingH1(markdown: string): string {
  const { frontmatter, body } = splitLeadingFrontmatter(markdown);
  const stripped = body
    .replace(/^#\s+.+?(?:\n{1,2}|$)/, '')
    .trimStart();
  return frontmatter ? `${frontmatter}\n${stripped}` : stripped;
}

function splitLeadingFrontmatter(markdown: string): { frontmatter?: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, '\n').trimStart();
  const match = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  if (!match) return { body: normalized };
  return {
    frontmatter: match[0].trimEnd(),
    body: normalized.slice(match[0].length).trimStart()
  };
}
