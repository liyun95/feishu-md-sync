import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractMarkdownCodeBlocks,
  landMultisdkDocs,
  planMultisdkDocsLanding
} from '../src/multisdk/land-docs.js';

const tempDirs: string[] = [];

describe('multisdk docs landing', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('extracts canonical language code blocks from reviewed Markdown', () => {
    const blocks = extractMarkdownCodeBlocks([
      '```python',
      'print("baseline")',
      '```',
      '',
      '```java',
      'System.out.println("reviewed");',
      '```',
      '',
      '```js',
      'console.log("reviewed");',
      '```'
    ].join('\n'), 'javascript');

    expect(blocks).toEqual([
      expect.objectContaining({
        language: 'js',
        code: 'console.log("reviewed");'
      })
    ]);
  });

  it('plans a patch that replaces only matching language blocks and preserves wrappers', async () => {
    const repo = await tempDir();
    const target = 'site/en/userGuide/schema/nullable-and-default.md';
    await mkdir(join(repo, 'site/en/userGuide/schema'), { recursive: true });
    const targetMarkdown = [
      '---',
      'title: Nullable Fields',
      '---',
      '',
      '# Nullable Fields',
      '',
      '<Tabs>',
      '',
      '```java',
      'System.out.println("old one");',
      '```',
      '',
      '[Local link](../schema.md)',
      '',
      '```python',
      'print("keep python")',
      '```',
      '',
      '```java',
      'System.out.println("old two");',
      '```',
      '',
      '</Tabs>',
      ''
    ].join('\n');
    await writeFile(join(repo, target), targetMarkdown, 'utf8');
    const reviewedMarkdown = [
      '# Remote',
      '',
      '```java',
      'System.out.println("reviewed one");',
      '```',
      '',
      '```java',
      'System.out.println("reviewed two");',
      '```',
      ''
    ].join('\n');

    const report = await planMultisdkDocsLanding({
      language: 'java',
      repo,
      target,
      reviewedMarkdown
    });

    expect(report.replacedBlocks).toBe(2);
    expect(report.verified).toBe(true);
    expect(report.diff).toContain('-System.out.println("old one");');
    expect(report.diff).toContain('+System.out.println("reviewed one");');
    expect(report.desiredMarkdown).toContain('title: Nullable Fields');
    expect(report.desiredMarkdown).toContain('[Local link](../schema.md)');
    expect(report.desiredMarkdown).toContain('print("keep python")');
  });

  it('writes the target file and reviewed baseline only when write is enabled', async () => {
    const repo = await tempDir();
    const taskDir = await tempDir();
    const target = 'site/en/page.md';
    await mkdir(join(repo, 'site/en'), { recursive: true });
    await writeFile(join(repo, target), [
      '```java',
      'old();',
      '```',
      ''
    ].join('\n'), 'utf8');

    const dryRun = await landMultisdkDocs({
      taskDir,
      language: 'java',
      repo,
      target,
      reviewedMarkdown: [
        '```java',
        'reviewed();',
        '```',
        ''
      ].join('\n'),
      write: false
    });

    expect(dryRun.mode).toBe('dry-run');
    expect(await readFile(join(repo, target), 'utf8')).toContain('old();');

    const write = await landMultisdkDocs({
      taskDir,
      language: 'java',
      repo,
      target,
      reviewedMarkdown: [
        '```java',
        'reviewed();',
        '```',
        ''
      ].join('\n'),
      write: true
    });

    expect(write.mode).toBe('write');
    expect(await readFile(join(repo, target), 'utf8')).toContain('reviewed();');
    expect(await readFile(join(taskDir, 'inputs/feishu.reviewed-baseline.md'), 'utf8')).toContain('reviewed();');
  });

  it('fails when reviewed and target language block counts differ', async () => {
    const repo = await tempDir();
    const target = 'site/en/page.md';
    await mkdir(join(repo, 'site/en'), { recursive: true });
    await writeFile(join(repo, target), [
      '```java',
      'one();',
      '```',
      '',
      '```java',
      'two();',
      '```',
      ''
    ].join('\n'), 'utf8');

    await expect(planMultisdkDocsLanding({
      language: 'java',
      repo,
      target,
      reviewedMarkdown: [
        '```java',
        'onlyOne();',
        '```',
        ''
      ].join('\n')
    })).rejects.toThrow(/reviewed java blocks \(1\) does not match target java blocks \(2\)/);
  });

  it('rejects absolute or escaping target paths before reading or writing', async () => {
    const repo = await tempDir();

    await expect(planMultisdkDocsLanding({
      language: 'java',
      repo,
      target: '/tmp/outside.md',
      reviewedMarkdown: '```java\nok();\n```\n'
    })).rejects.toThrow(/relative to --repo/);

    await expect(planMultisdkDocsLanding({
      language: 'java',
      repo,
      target: '../outside.md',
      reviewedMarkdown: '```java\nok();\n```\n'
    })).rejects.toThrow(/must stay inside --repo/);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-multisdk-land-docs-'));
  tempDirs.push(dir);
  return dir;
}
