import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderCliFailure } from '../src/cli/error-output.js';
import { printFormatted } from '../src/cli/output.js';
import { CliFailure } from '../src/core/cli-failure.js';

describe('CLI pretty output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the provider code in the JSON error contract', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    renderCliFailure(new CliFailure({
      type: 'internal',
      subtype: 'openapi_error',
      providerCode: 4003101,
      message: 'doc is applying',
      retryable: false
    }), 'json');

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        type: 'internal',
        subtype: 'openapi_error',
        providerCode: 4003101,
        retryable: false
      }
    });
  });

  it('prints Whiteboard operations, blockers, and confirmation requirements', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });

    printFormatted({
      mode: 'dry-run',
      plan: {
        strategy: 'block-patch',
        scopedPatch: { operations: [], blockers: [] },
        whiteboards: {
          assets: [{
            assetKey: 'assets/cagra.png',
            state: 'untracked',
            action: 'replace remote image with whiteboard'
          }],
          operations: [{ kind: 'whiteboard-create', assetKey: 'assets/cagra.png' }],
          blockers: [{
            code: 'remote-whiteboard-changed',
            assetKey: 'assets/other.png',
            message: 'remote Whiteboard changed'
          }]
        },
        warnings: [],
        requiresUntrackedRemoteConfirmation: true,
        requiresCollaborationRiskConfirmation: true,
        requiredRemoteWhiteboardOverwrites: ['assets/other.png']
      }
    }, 'pretty');

    expect(lines).toContain('whiteboard[untracked]: assets/cagra.png - replace remote image with whiteboard');
    expect(lines).toContain('blocker[remote-whiteboard-changed]: assets/other.png - remote Whiteboard changed');
    expect(lines).toContain('requires: --confirm-untracked-remote');
    expect(lines).toContain('requires: --confirm-collaboration-risk');
    expect(lines).toContain('requires: --confirm-remote-whiteboard-overwrite assets/other.png');
  });

  it('prints Callout status summaries and blockers', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });

    printFormatted({
      state: 'local-changed',
      localChanged: true,
      remoteChanged: false,
      recommendation: { action: 'publish-dry-run', reason: 'local changed' },
      callouts: [{
        type: 'note',
        action: 'update',
        locator: { sectionPath: ['Build index'], kind: 'callout', ordinal: 0 },
        childChanges: [
          { action: 'update', ordinal: 1, blockType: 2 },
          { action: 'create', ordinal: 2, blockType: 12 }
        ]
      }],
      calloutBlockers: [{
        code: 'callout-type-change',
        message: 'Callout type changes are unsupported'
      }]
    }, 'pretty');

    expect(lines).toContain('callout[note]: Build index [0]');
    expect(lines).toContain('  ~ paragraph 2');
    expect(lines).toContain('  + bullet 3');
    expect(lines).toContain('blocker[callout-type-change]: Callout type changes are unsupported');
  });

  it('prints first-class Code block changes', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });

    printFormatted({
      state: 'local-changed',
      localChanged: true,
      remoteChanged: false,
      recommendation: { action: 'publish-dry-run', reason: 'local changed' },
      codeBlocks: [{
        action: 'update',
        locator: { sectionPath: ['Build index'], kind: 'code', ordinal: 0 },
        language: 'go',
        contentChanged: true,
        languageChange: { from: 'python', to: 'go' }
      }, {
        action: 'move',
        locator: { sectionPath: ['Search'], kind: 'code', ordinal: 1 },
        language: 'bash',
        move: { from: ['Build index'], to: ['Search'] }
      }],
      codeBlockers: [{ code: 'remote-code-conflict', message: 'remote changed content' }]
    }, 'pretty');

    expect(lines).toContain('code[go]: Build index [0]');
    expect(lines).toContain('  ~ content');
    expect(lines).toContain('  → language: python -> go');
    expect(lines).toContain('  → move: Build index -> Search');
    expect(lines).toContain('blocker[remote-code-conflict]: remote changed content');
  });

  it('prints dialect, link summary, and structured diagnostics', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });

    printFormatted({
      mode: 'dry-run',
      plan: {
        strategy: 'blocked',
        dialect: 'zdoc-authoring',
        linkResolution: {
          resolvedToFeishu: 3,
          resolvedToPublicSite: 1,
          unresolved: 0
        },
        dialectBlockers: [{
          code: 'unsupported-mdx-component',
          message: 'Unsupported Zdoc component <Tabs>.',
          location: { file: 'article.md', line: 42 }
        }],
        dialectWarnings: [{
          code: 'link-resolver-stale-cache',
          message: 'Using cached Feishu Base mappings.'
        }],
        warnings: []
      }
    }, 'pretty');

    expect(lines).toContain('dialect: zdoc-authoring');
    expect(lines).toContain('links: 3 Feishu, 1 public fallback, 0 unresolved');
    expect(lines).toContain('blocker[unsupported-mdx-component]: Unsupported Zdoc component <Tabs>. at article.md:42');
    expect(lines).toContain('warning[link-resolver-stale-cache]: Using cached Feishu Base mappings.');
  });

  it('prints structured Zdoc round-trip items', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });

    printFormatted({
      mode: 'dry-run',
      plan: {
        strategy: 'blocked',
        warnings: [],
        zdocRoundTrip: {
          safeToPublish: false,
          items: [{
            code: 'procedures-move',
            severity: 'info',
            component: 'Procedures',
            message: 'move <Procedures> to the canonical boundary'
          }, {
            code: 'supademo-ambiguous',
            severity: 'blocker',
            component: 'Supademo',
            message: 'no unique ISV correspondence'
          }]
        }
      }
    }, 'pretty');

    expect(lines).toContain(
      'zdoc[info][procedures-move]: move <Procedures> to the canonical boundary'
    );
    expect(lines).toContain(
      'zdoc[blocker][supademo-ambiguous]: no unique ISV correspondence'
    );
  });
});
