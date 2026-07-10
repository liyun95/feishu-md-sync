import path from 'node:path';

export type PublishTitleSource = 'option' | 'first H1' | 'file basename';

export function resolvePublishTitle(input: {
  sourcePath: string;
  markdown: string;
  title?: string;
}): { title: string; titleSource: PublishTitleSource } {
  const explicit = clean(input.title);
  if (explicit) return { title: explicit, titleSource: 'option' };

  const firstH1 = input.markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((title) => title);
  if (firstH1) return { title: firstH1, titleSource: 'first H1' };

  return {
    title: path.basename(input.sourcePath, path.extname(input.sourcePath)) || 'Untitled',
    titleSource: 'file basename'
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
