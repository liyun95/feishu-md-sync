import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('CLI help surface', () => {
  it('keeps top-level workflow commands discoverable', async () => {
    const { stdout } = await runCli(['--help']);

    for (const command of ['sync', 'push', 'review-draft', 'publish-new', 'status', 'pull', 'diff', 'merge', 'code-blocks', 'multisdk', 'reference', 'release', 'harness', 'workflow']) {
      expect(stdout).toContain(command);
    }
  });

  it('documents publish-new as first-publication with safe common usage shapes', async () => {
    const { stdout } = await runCli(['publish-new', '--help']);

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
    const { stdout } = await runCli(['sync', '--help']);

    expect(stdout).not.toContain('--section');
  });

  it('documents review-draft as the Milvus review push command', async () => {
    const { stdout } = await runCli(['review-draft', '--help']);

    expect(stdout).toContain('push a Milvus review draft to an existing Feishu document');
    expect(stdout).toContain('--link-base-url <url>');
    expect(stdout).toContain('--markdown-engine <engine>');
    expect(stdout).toContain('(default: "local")');
    expect(stdout).toContain('--replace-all');
  });

  it('honors sync subcommand options before doing IO', async () => {
    const result = await runCli([
      'sync',
      '--markdown-engine',
      'invalid',
      'missing.md',
      'doccn123456789012345678901234'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --markdown-engine invalid');
  });

  it('lists scoped section push options', async () => {
    const result = await runCli(['push', '--help']);

    expect(result.stdout).toContain('--insert-section <heading>');
    expect(result.stdout).toContain('--before-section <heading>');
    expect(result.stdout).toContain('--after-section <heading>');
    expect(result.stdout).toContain('--before-heading <heading>');
  });

  it('rejects insert-section without a relative target', async () => {
    const result = await runCli(['push', 'doc.md', 'doc1234567890123', '--insert-section', 'New']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--insert-section requires --before-section or --after-section.');
  });

  it('rejects before-section without insert-section', async () => {
    const result = await runCli(['push', 'doc.md', 'doc1234567890123', '--before-section', 'Existing']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--before-section and --after-section require --insert-section.');
  });

  it('rejects multiple scoped push modes', async () => {
    const result = await runCli([
      'push',
      'doc.md',
      'doc1234567890123',
      '--scope',
      'heading:"Existing"',
      '--before-heading',
      'How it works'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Scoped push options are mutually exclusive: --scope, --before-heading.');
  });

  it('rejects document-replace with scoped push modes', async () => {
    const result = await runCli([
      'push',
      'doc.md',
      'doc1234567890123',
      '--strategy',
      'document-replace',
      '--scope',
      'heading:"Existing"',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--strategy document-replace cannot be combined with scoped push options.');
  });
});
