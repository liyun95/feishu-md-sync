import { afterEach, describe, expect, it, vi } from 'vitest';
import { printFormatted } from '../src/cli/output.js';

describe('CLI pretty output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
