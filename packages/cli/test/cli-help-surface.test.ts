import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI help surface', () => {
  it('keeps top-level workflow commands discoverable', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', '--help'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    });

    for (const command of ['sync', 'push', 'publish-new', 'status', 'pull', 'diff', 'merge', 'code-blocks', 'multisdk', 'reference', 'release', 'harness', 'workflow']) {
      expect(stdout).toContain(command);
    }
  });

  it('documents publish-new as first-publication with safe common usage shapes', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', 'publish-new', '--help'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    });

    expect(stdout).toContain('publish a local Markdown file to a new Feishu document');
    expect(stdout).toContain('md2feishu publish-new <doc.md>');
    expect(stdout).toContain('md2feishu publish-new <doc.md> --title "Doc Title"');
    expect(stdout).toContain('md2feishu publish-new <doc.md> --title "Doc Title" --wiki-space-id <space-id> --wiki-parent <node-token>');
    expect(stdout).toContain('md2feishu publish-new <doc.md> --title "Doc Title" --folder-token <folder-token>');
    expect(stdout).toContain('md2feishu publish-new <doc.md> --title "Doc Title" --app-owned');
    expect(stdout).toContain('Default: dry-run. Add --write to create the Feishu document.');
    expect(stdout).toContain('--markdown-engine <engine>');
    expect(stdout).toContain('(default: "local")');
    expect(stdout).toContain('--folder-token');
    expect(stdout).toContain('--app-owned');
    expect(stdout).toContain('--wiki-space-id');
  });

  it('does not expose section scope as a public sync option', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', 'sync', '--help'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    });

    expect(stdout).not.toContain('--section');
  });

  it('honors sync subcommand options before doing IO', async () => {
    await expect(execFileAsync('npx', [
      'tsx',
      'src/cli/index.ts',
      'sync',
      '--markdown-engine',
      'invalid',
      'missing.md',
      'doccn123456789012345678901234'
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid --markdown-engine invalid')
    });
  });
});
