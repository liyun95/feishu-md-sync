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
});
