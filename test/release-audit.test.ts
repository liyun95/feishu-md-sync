import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { auditLinks, auditReleaseNotes, auditVariables, markdownHeadingAnchor } from '../src/release/audit.js';
import type { SdkTagMatrix } from '../src/release/sdk-tags.js';

const matrix: SdkTagMatrix = {
  releaseLine: '2.6.x',
  generatedAt: '2026-05-25T00:00:00.000Z',
  blocked: [],
  rows: [
    {
      sdk: 'java',
      label: 'Java',
      repository: 'milvus-io/milvus-sdk-java',
      releaseLine: '2.6.x',
      matchedTag: 'v2.6.17',
      variablesValue: '2.6.17',
      evidence: 'tag',
      status: 'ok'
    }
  ]
};

describe('release audits', () => {
  it('reports Variables.json changes from the SDK matrix', () => {
    const audit = auditVariables({
      variablesJson: JSON.stringify({ milvus_sdk_java_version: '2.6.16' }, null, 2),
      matrix,
      variableNames: { java: 'milvus_sdk_java_version' }
    });

    expect(audit.changes).toEqual([
      {
        sdk: 'java',
        variable: 'milvus_sdk_java_version',
        currentValue: '2.6.16',
        expectedValue: '2.6.17',
        status: 'change'
      }
    ]);
    expect(audit.passed).toBe(false);
  });

  it('finds whether release notes need a new section', () => {
    const audit = auditReleaseNotes({
      releaseVersion: '2.6.17',
      localMarkdown: '# Release Notes\n\n## v2.6.16\n\nOld text\n',
      remoteMarkdown: '## v2.6.17\n\n- Added array remove support.\n'
    });

    expect(audit.sectionExists).toBe(false);
    expect(audit.proposedSection).toContain('## v2.6.17');
    expect(audit.passed).toBe(false);
  });

  it('validates explicit release-note links and anchors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-links-'));
    try {
      const docPath = 'site/en/userGuide/insert-and-delete/upsert-entities.md';
      await mkdir(join(dir, 'site/en/userGuide/insert-and-delete'), { recursive: true });
      await writeFile(join(dir, docPath), '## Upsert ARRAY fields with partial update operators\n\nBody\n', 'utf8');

      const audit = await auditLinks({
        milvusDocsPath: dir,
        releaseMarkdown: '- Added ARRAY_REMOVE support.\n',
        linkTargets: [
          {
            keyword: 'ARRAY_REMOVE',
            localPath: docPath,
            anchor: 'Upsert-ARRAY-fields-with-partial-update-operators'
          }
        ]
      });

      expect(markdownHeadingAnchor('Upsert ARRAY fields with partial update operators')).toBe(
        'Upsert-ARRAY-fields-with-partial-update-operators'
      );
      expect(audit.items[0]).toMatchObject({ fileExists: true, anchorExists: true, status: 'ok' });
      expect(audit.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks release-linked user docs that still contain required language placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-placeholder-links-'));
    try {
      const docPath = 'site/en/userGuide/insert-and-delete/upsert-entities.md';
      await mkdir(join(dir, 'site/en/userGuide/insert-and-delete'), { recursive: true });
      await writeFile(join(dir, docPath), [
        '## Upsert ARRAY fields with partial update operators',
        '',
        '```python',
        'client.upsert(...)',
        '```',
        '',
        '```javascript',
        '// nodejs',
        '```',
        '',
        '```go',
        '// go',
        '```',
        '',
        '```bash',
        '# restful',
        '```',
        '',
        '### Limits',
        '',
        'Body',
        ''
      ].join('\n'), 'utf8');

      const audit = await auditLinks({
        milvusDocsPath: dir,
        releaseMarkdown: '- Added gRPC and REST support for ARRAY_REMOVE.\n',
        linkTargets: [
          {
            keyword: 'ARRAY_REMOVE',
            localPath: docPath,
            anchor: 'Upsert-ARRAY-fields-with-partial-update-operators',
            requiredLanguages: ['nodejs', 'go', 'curl']
          }
        ]
      });

      expect(audit.passed).toBe(false);
      expect(audit.items[0]).toMatchObject({
        status: 'placeholder',
        requiredLanguages: ['javascript', 'go', 'restful'],
        placeholderIssues: [
          { language: 'javascript', line: 7, placeholder: '// nodejs' },
          { language: 'go', line: 11, placeholder: '// go' },
          { language: 'restful', line: 15, placeholder: '# restful' }
        ]
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches anchors before Milvus version suffixes in headings', () => {
    expect(markdownHeadingAnchor('Upsert ARRAY fields with partial-update operators | Milvus v2.6.17+')).toBe(
      'Upsert-ARRAY-fields-with-partial-update-operators'
    );
  });
});
