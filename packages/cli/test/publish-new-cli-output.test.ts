import { describe, expect, it } from 'vitest';
import { publishNewSummaryLines } from '../src/sync/publish-new-output.js';
import type { PublishNewRunResult } from '../src/sync/publish-new.js';

describe('publish-new CLI output', () => {
  it('prints dry-run intent, inferred values, planned writes, and write guidance', () => {
    expect(publishNewSummaryLines(result())).toEqual([
      'Intent: publish local Markdown to a new Feishu document',
      'Title: Doc',
      'Title source: first H1',
      'Source: /tmp/doc.md',
      'Destination: folder folder-token',
      'Destination source: --folder-token',
      'Creation strategy: block-pipeline',
      'Staging folder: folder-token',
      'Final document type: docx in Drive folder',
      'Wiki move: no',
      'Duplicate title check: passed',
      'Mode: dry-run, no Feishu document will be created',
      'Receipt: /tmp/.sync/feishu/doc.md.doc-created.json after write verification',
      '',
      'Planned Feishu changes:',
      '- create 1 docx document',
      '- create 2 docx child blocks',
      '- pull readback for verification',
      '',
      'Run with --write to publish.'
    ]);
  });

  it('ends successful writes with the next push command', () => {
    expect(publishNewSummaryLines(result({
      mode: 'write',
      receiptWritten: true,
      document: {
        documentId: 'doc-created',
        docxUrl: 'https://example.feishu.cn/docx/doc-created',
        publishedUrl: 'https://example.feishu.cn/docx/doc-created'
      }
    })).slice(-5)).toEqual([
      'Published: https://example.feishu.cn/docx/doc-created',
      'Receipt: /tmp/.sync/feishu/doc.md.doc-created.json',
      'Verification: passed',
      '',
      "Next update command:\nmd2feishu push /tmp/doc.md 'https://example.feishu.cn/docx/doc-created'"
    ]);
  });

  it('prints app-owned dry-runs as an explicit destination', () => {
    expect(publishNewSummaryLines(result({
      plan: {
        ...result().plan,
        destination: {
          kind: 'app-owned',
          source: '--app-owned'
        }
      }
    }))).toContain('Destination: app-owned docx');
  });
});

function result(overrides: Partial<PublishNewRunResult> = {}): PublishNewRunResult {
  return {
    mode: 'dry-run',
    plan: {
      intent: 'publish local Markdown to a new Feishu document',
      sourcePath: '/tmp/doc.md',
      title: 'Doc',
      titleSource: 'first H1',
      creationStrategy: 'block-pipeline',
      destination: {
        kind: 'folder',
        folderToken: 'folder-token',
        source: '--folder-token'
      },
      duplicateCandidates: [],
      creates: {
        documents: 1,
        blocks: 2,
        wikiMove: false
      },
      receiptPath: '/tmp/.sync/feishu/doc.md.doc-created.json'
    },
    markdownEngineWarnings: [],
    receiptPath: '/tmp/.sync/feishu/doc.md.doc-created.json',
    receiptWritten: false,
    verification: {
      ok: true,
      expectedHash: 'hash',
      actualHash: 'hash'
    },
    ...overrides
  };
}
