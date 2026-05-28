import { describe, expect, it } from 'vitest';
import type { HarnessTaskSummary } from '../src/harness/task.js';
import { getHarnessTools, parseHarnessWorkflow } from '../src/harness/tools.js';

describe('harness task contract', () => {
  it('accepts first-class workflow task summaries', () => {
    const summary = {
      kind: 'feishu-harness-task-summary',
      version: 1,
      workflow: 'sdk-reference-authoring',
      taskDir: 'runs/reference/java',
      status: 'in-progress',
      subject: { sdk: 'java' },
      artifacts: [{ path: 'reference-manifest.json', required: true, exists: false }],
      nextCommands: ['md2feishu workflow show sdk-reference-authoring']
    } satisfies HarnessTaskSummary;

    expect(summary.workflow).toBe('sdk-reference-authoring');
  });

  it('keeps multisdk as a compatibility alias', () => {
    expect(parseHarnessWorkflow('multisdk')).toBe('multisdk');
    expect(getHarnessTools('multisdk').tools.map((tool) => tool.name)).toContain('multisdk apply');
    expect(getHarnessTools('multisdk-examples').tools.map((tool) => tool.name)).toContain('multisdk apply');
  });

  it('exposes tools for SDK reference release separately from authoring', () => {
    const authoring = getHarnessTools('sdk-reference-authoring');
    const release = getHarnessTools('sdk-reference-web-content-release');

    expect(authoring.tools.map((tool) => tool.name)).toContain('reference apply');
    expect(authoring.tools.map((tool) => tool.name)).not.toContain('reference export');
    expect(release.tools.map((tool) => tool.name)).toContain('reference export');
  });
});
