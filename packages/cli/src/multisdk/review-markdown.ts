import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unifiedDiff } from '../sync/diff.js';
import type { MultisdkLanguage } from './language.js';

export type WriteMultisdkReviewMarkdownInput = {
  taskDir: string;
  language: MultisdkLanguage;
  remoteMarkdownPath: string;
  snippetPaths: string[];
};

export type WriteMultisdkReviewMarkdownResult = {
  markdownPath: string;
  diffPath: string;
};

export async function writeMultisdkReviewMarkdown(
  input: WriteMultisdkReviewMarkdownInput
): Promise<WriteMultisdkReviewMarkdownResult> {
  const remoteMarkdown = await readFile(input.remoteMarkdownPath, 'utf8');
  const snippets = await Promise.all(input.snippetPaths.map((path) => readFile(path, 'utf8')));
  const desired = insertLanguageBlocks(remoteMarkdown, input.language, snippets);
  const markdownPath = join(input.taskDir, 'outputs', 'review.md');
  const diffPath = join(input.taskDir, 'outputs', 'review.diff');
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, desired, 'utf8');
  await writeFile(diffPath, unifiedDiff('remote.md', 'review.md', remoteMarkdown, desired), 'utf8');
  return { markdownPath, diffPath };
}

function insertLanguageBlocks(markdown: string, language: MultisdkLanguage, snippets: string[]): string {
  let index = 0;
  return markdown.replace(/(```python\n[\s\S]*?```\n?)/gi, (match) => {
    const snippet = snippets[index++];
    if (snippet === undefined) return match;
    return `${match.replace(/\n?$/, '\n')}\n\`\`\`${fenceLanguage(language)}\n${snippet.trim()}\n\`\`\`\n`;
  });
}

function fenceLanguage(language: MultisdkLanguage): string {
  return language === 'restful' ? 'bash' : language;
}
