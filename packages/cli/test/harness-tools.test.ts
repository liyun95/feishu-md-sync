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
      'multisdk environment',
      'multisdk prepare',
      'multisdk author',
      'multisdk validate',
      'multisdk apply-local',
      'multisdk record-push',
      'multisdk audit',
      'multisdk finalize',
      'doctor auth',
      'pull',
      'push'
    ]);
    expect(registry.tools.find((tool) => tool.name === 'multisdk init')).toEqual(expect.objectContaining({
      requires: ['feishuDoc', '--out', '--language'],
      writeRequires: ['user-selected target language']
    }));
    expect(registry.tools.find((tool) => tool.name === 'multisdk environment')).toEqual(expect.objectContaining({
      writeRequires: ['user-confirmed Milvus target']
    }));
    expect(registry.tools.find((tool) => tool.name === 'multisdk validate')).toEqual(expect.objectContaining({
      writesFeishu: false,
      writeRequires: ['confirmed Milvus target', 'prepared verifier', 'authored snippets', 'real Milvus execution']
    }));
    expect(registry.tools.find((tool) => tool.name === 'multisdk author')).toEqual(expect.objectContaining({
      writesFeishu: false,
      writeRequires: ['prepared verifier', 'non-empty selected-language snippets']
    }));
    expect(registry.tools.find((tool) => tool.name === 'push')).toEqual(expect.objectContaining({
      writesFeishu: true,
      writeRequires: ['local review markdown', 'user approval', '--write']
    }));
    expect(registry.tools.map((tool) => tool.name)).not.toContain('multisdk apply');
    expect(registry.tools.map((tool) => tool.name)).not.toContain('multisdk land-docs');
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
