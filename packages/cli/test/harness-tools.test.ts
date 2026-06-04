import { describe, expect, it } from 'vitest';
import { getHarnessTools, parseHarnessWorkflow } from '../src/harness/tools.js';

describe('harness tools registry', () => {
  it('lists the multisdk tool surface with safety metadata', () => {
    const registry = getHarnessTools('multisdk');

    expect(registry).toEqual(expect.objectContaining({
      kind: 'feishu-harness-tools',
      version: 1,
      workflow: 'multisdk'
    }));
    expect(registry.tools.map((tool) => tool.name)).toEqual([
      'multisdk init',
      'multisdk status',
      'multisdk export',
      'multisdk profile',
      'multisdk verify',
      'multisdk diff',
      'multisdk apply',
      'multisdk audit',
      'multisdk land-docs',
      'multisdk finalize',
      'doctor auth',
      'code-blocks inspect',
      'code-blocks audit',
      'pull'
    ]);
    expect(registry.tools.find((tool) => tool.name === 'multisdk apply')).toEqual(expect.objectContaining({
      mode: 'dry-run-or-write',
      writesFeishu: true,
      writesLocalFiles: true,
      writesExternalRepos: false,
      requires: ['taskDir', 'language'],
      writeRequires: ['--write', 'validation evidence', 'fresh dry-run']
    }));
  });

  it('parses supported workflows and rejects unsupported workflows', () => {
    expect(parseHarnessWorkflow('push')).toBe('push');
    expect(parseHarnessWorkflow('review-draft')).toBe('review-draft');
    expect(parseHarnessWorkflow('publish-new')).toBe('publish-new');
    expect(parseHarnessWorkflow('multisdk')).toBe('multisdk');
    expect(() => parseHarnessWorkflow('release')).toThrow(/Unsupported harness workflow release/);
    expect(() => parseHarnessWorkflow('')).toThrow(/Unsupported harness workflow/);
  });

  it('lists publish-new as the first-publication tool surface', () => {
    const registry = getHarnessTools('publish-new');

    expect(registry.workflow).toBe('publish-new');
    expect(registry.tools.find((tool) => tool.name === 'publish-new')).toEqual(expect.objectContaining({
      mode: 'dry-run-or-write',
      writesFeishu: true,
      requires: ['markdownFile', 'destination'],
      writeRequires: ['--write', 'approved dry-run', 'explicit or configured destination', 'duplicate-title review']
    }));
  });

  it('lists push as the Markdown write tool surface', () => {
    const registry = getHarnessTools('push');

    expect(registry.workflow).toBe('push');
    expect(registry.tools.find((tool) => tool.name === 'push')).toEqual(expect.objectContaining({
      mode: 'dry-run-or-write',
      writesFeishu: true,
      requires: ['markdownFile', 'feishuDoc'],
      writeRequires: ['--write', 'approved dry-run strategy plan', '--replace-all when selected strategy is document-replace']
    }));
  });

  it('lists review-draft as the Milvus review write tool surface', () => {
    const registry = getHarnessTools('review-draft');

    expect(registry.workflow).toBe('review-draft');
    expect(registry.tools.map((tool) => tool.name)).toEqual(['pull', 'review-draft']);
    expect(registry.tools.find((tool) => tool.name === 'review-draft')).toEqual(expect.objectContaining({
      mode: 'dry-run-or-write',
      writesFeishu: true,
      requires: ['markdownFile', 'feishuDoc'],
      writeRequires: ['--write', 'approved dry-run strategy plan', 'passing review draft checks', '--replace-all when selected strategy is document-replace']
    }));
  });
});
