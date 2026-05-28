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
    expect(parseHarnessWorkflow('multisdk')).toBe('multisdk');
    expect(() => parseHarnessWorkflow('release')).toThrow(/Unsupported harness workflow release/);
    expect(() => parseHarnessWorkflow('')).toThrow(/Unsupported harness workflow/);
  });
});
