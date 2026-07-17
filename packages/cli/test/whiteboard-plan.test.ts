import { describe, expect, it } from 'vitest';
import type { WhiteboardReceiptEntry } from '../src/receipts/publish-receipt.js';
import type { SemanticAssetNode, SemanticDocument } from '../src/semantic/types.js';
import type { LocalWhiteboardAsset } from '../src/whiteboards/local-assets.js';
import { planWhiteboardPublish } from '../src/whiteboards/whiteboard-plan.js';

describe('Whiteboard publish plan', () => {
  it('creates a Whiteboard from a uniquely matched remote image', () => {
    const result = planWhiteboardPublish(planningInput({ remote: remoteAsset('image', 'image_block', 'image_token') }));

    expect(result.blockers).toEqual([]);
    expect(result.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-create',
      assetKey: 'assets/cagra.png',
      remoteImageBlockId: 'image_block'
    })]);
    expect(result.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(result.requiresCollaborationRiskConfirmation).toBe(true);
  });

  it('adopts a uniquely matched untracked remote Whiteboard', () => {
    const result = planWhiteboardPublish(planningInput({
      remote: remoteAsset('whiteboard', 'wb_block', 'wb_token'),
      remoteStates: new Map([['wb_token', { hash: 'remote-current' }]])
    }));

    expect(result.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-adopt',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    })]);
    expect(result.assets).toContainEqual(expect.objectContaining({ state: 'untracked', remote: 'untracked' }));
  });

  it('does not initialize a Whiteboard from an untracked direct SVG', () => {
    const result = planWhiteboardPublish({
      ...planningInput({ remote: remoteAsset('image', 'image_block', 'image_token') }),
      localAssets: [{
        ...localAsset('svg-current'),
        sourceKind: 'direct-svg'
      }]
    });

    expect(result.operations).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.assets).toEqual([]);
  });

  it('blocks untracked correspondence when a local image was inserted before the remote slot', () => {
    const followingLocalImage: SemanticAssetNode = {
      ...localNode(),
      locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 1 },
      source: './assets/existing.png'
    };
    const result = planWhiteboardPublish({
      ...planningInput({ remote: remoteAsset('image', 'image_block', 'image_token') }),
      localDocument: { nodes: [localNode(), followingLocalImage] }
    });

    expect(result.operations).toEqual([]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-correspondence-ambiguous' }));
  });

  it('blocks multiple untracked asset slots in the same section', () => {
    const secondLocal: SemanticAssetNode = {
      ...localNode(),
      locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 1 },
      source: './assets/other.png'
    };
    const secondRemote = {
      ...remoteAsset('image', 'other_image', 'other_token'),
      locator: secondLocal.locator
    };
    const result = planWhiteboardPublish({
      ...planningInput({ remote: remoteAsset('image', 'image_block', 'image_token') }),
      localDocument: { nodes: [localNode(), secondLocal] },
      remoteDocument: { nodes: [remoteAsset('image', 'image_block', 'image_token'), secondRemote] }
    });

    expect(result.operations).toEqual([]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-correspondence-ambiguous' }));
  });

  it('blocks untracked correspondence when adjacent text content differs', () => {
    const localText = {
      kind: 'text' as const,
      locator: { sectionPath: ['Architecture'], kind: 'text' as const, ordinal: 0 },
      blockType: 2,
      markdown: 'New local context.'
    };
    const remoteText = {
      ...localText,
      markdown: 'Different remote context.',
      remoteBlockId: 'remote_text'
    };
    const result = planWhiteboardPublish({
      ...planningInput({ remote: remoteAsset('image', 'image_block', 'image_token') }),
      localDocument: { nodes: [localText, localNode()] },
      remoteDocument: { nodes: [remoteText, remoteAsset('image', 'image_block', 'image_token')] }
    });

    expect(result.operations).toEqual([]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-placement-mismatch' }));
  });

  it('returns clean when local SVG and remote nodes match the receipt baselines', () => {
    const result = planWhiteboardPublish(trackedInput({ localHash: 'svg-base', remoteHash: 'remote-base' }));

    expect(result.operations).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.assets).toEqual([expect.objectContaining({ state: 'clean', action: 'no-op' })]);
  });

  it('protects a tracked direct SVG without planning a Whiteboard write', () => {
    const result = planWhiteboardPublish({
      ...trackedInput({ localHash: 'svg-base', remoteHash: 'remote-base' }),
      intent: 'protect',
      localAssets: [{
        ...localAsset('svg-base'),
        svgKey: 'assets/cagra.svg',
        sourceKind: 'direct-svg'
      }]
    });

    expect(result.blockers).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.assets).toEqual([expect.objectContaining({
      state: 'clean',
      action: 'preserve tracked whiteboard',
      protection: 'tracked',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    })]);
  });

  it('requires asset-specific confirmation before updating a tracked direct SVG', () => {
    const input = {
      ...trackedInput({ localHash: 'svg-current', remoteHash: 'remote-base' }),
      localAssets: [{
        ...localAsset('svg-current'),
        svgKey: 'assets/cagra.svg',
        sourceKind: 'direct-svg' as const
      }]
    };
    const blocked = planWhiteboardPublish(input);
    const confirmed = planWhiteboardPublish({
      ...input,
      confirmedRemoteOverwrites: new Set(['assets/cagra.png'])
    });

    expect(blocked.operations).toEqual([]);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({
      code: 'protected-whiteboard-overwrite-confirmation-required'
    }));
    expect(confirmed.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-update',
      reason: 'confirmed-protected-overwrite'
    })]);
  });

  it('updates a tracked Whiteboard when only the local SVG changed', () => {
    const result = planWhiteboardPublish(trackedInput({ localHash: 'svg-current', remoteHash: 'remote-base' }));

    expect(result.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-update',
      whiteboardToken: 'wb_token',
      remoteStateHash: 'remote-base',
      reason: 'local-changed'
    })]);
    expect(result.assets).toEqual([expect.objectContaining({ state: 'local-changed', local: 'changed', remote: 'unchanged' })]);
  });

  it('blocks a remote-only change by default', () => {
    const result = planWhiteboardPublish(trackedInput({ localHash: 'svg-base', remoteHash: 'remote-current' }));

    expect(result.operations).toEqual([]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'remote-whiteboard-changed' }));
    expect(result.assets).toEqual([expect.objectContaining({ state: 'remote-changed' })]);
  });

  it('blocks overlapping local and remote changes by default', () => {
    const result = planWhiteboardPublish(trackedInput({ localHash: 'svg-current', remoteHash: 'remote-current' }));

    expect(result.operations).toEqual([]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-conflict' }));
    expect(result.assets).toEqual([expect.objectContaining({ state: 'conflict' })]);
  });

  it.each([
    ['remote-only', 'svg-base'],
    ['overlapping', 'svg-current']
  ])('allows an exact asset-specific overwrite for %s changes', (_name, localHash) => {
    const result = planWhiteboardPublish(trackedInput({
      localHash,
      remoteHash: 'remote-current',
      confirmed: new Set(['assets/cagra.png'])
    }));

    expect(result.blockers).toEqual([]);
    expect(result.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-update',
      assetKey: 'assets/cagra.png',
      remoteStateHash: 'remote-current',
      reason: 'confirmed-remote-overwrite'
    })]);
  });

  it('does not apply an overwrite confirmation to a different asset', () => {
    const result = planWhiteboardPublish(trackedInput({
      localHash: 'svg-current',
      remoteHash: 'remote-current',
      confirmed: new Set(['assets/other.png'])
    }));

    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-conflict' }));
  });

  it('blocks missing local, remote, and ambiguous asset correspondence', () => {
    const missingLocal = planWhiteboardPublish({
      ...trackedInput({ localHash: 'svg-base', remoteHash: 'remote-base' }),
      localAssets: []
    });
    expect(missingLocal.blockers).toContainEqual(expect.objectContaining({ code: 'missing-local-whiteboard-asset' }));

    const missingRemote = planWhiteboardPublish({
      ...trackedInput({ localHash: 'svg-base', remoteHash: 'remote-base' }),
      remoteDocument: { nodes: [] }
    });
    expect(missingRemote.blockers).toContainEqual(expect.objectContaining({ code: 'missing-remote-whiteboard' }));

    const ambiguous = planWhiteboardPublish(planningInput({
      remoteDocument: { nodes: [
        remoteAsset('image', 'image1', 'token1'),
        remoteAsset('image', 'image2', 'token2')
      ] }
    }));
    expect(ambiguous.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-correspondence-ambiguous' }));
  });

  it('keeps a new asset untracked even when other Whiteboards already have receipts', () => {
    const otherLocalNode: SemanticAssetNode = {
      ...localNode(),
      locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 1 },
      source: './assets/other.png'
    };
    const otherLocalAsset: LocalWhiteboardAsset = {
      ...localAsset('other-svg'),
      assetKey: 'assets/other.png',
      svgKey: 'assets/other.svg',
      locator: otherLocalNode.locator,
      pngPath: '/tmp/assets/other.png',
      svgPath: '/tmp/assets/other.svg'
    };
    const otherReceipt = {
      ...receipt(),
      assetKey: 'assets/other.png',
      pngPath: 'assets/other.png',
      svgPath: 'assets/other.svg',
      svgHash: 'other-svg',
      blockId: 'other_block',
      whiteboardToken: 'other_token',
      remoteStateHash: 'other-remote'
    };
    const result = planWhiteboardPublish({
      localDocument: { nodes: [localNode(), otherLocalNode] },
      remoteDocument: { nodes: [
        remoteAsset('image', 'image_block', 'image_token'),
        { ...remoteAsset('whiteboard', 'other_block', 'other_token'), locator: otherLocalNode.locator }
      ] },
      localAssets: [localAsset('svg-current'), otherLocalAsset],
      discoveryBlockers: [],
      receiptEntries: [otherReceipt],
      remoteStates: new Map([['other_token', { hash: 'other-remote' }]]),
      confirmedRemoteOverwrites: new Set()
    });

    expect(result.operations).toContainEqual(expect.objectContaining({ kind: 'whiteboard-create' }));
    expect(result.requiresUntrackedRemoteConfirmation).toBe(true);
  });

  it('promotes discovery blockers into a fail-closed plan', () => {
    const result = planWhiteboardPublish({
      ...planningInput({ remote: remoteAsset('image', 'image_block', 'image_token') }),
      discoveryBlockers: [{ code: 'invalid-svg', assetKey: 'assets/cagra.png', message: 'filter is unsupported' }]
    });

    expect(result.safeToWrite).toBe(false);
    expect(result.operations).toEqual([]);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'invalid-svg' }));
  });
});

function planningInput(input: {
  remote?: SemanticAssetNode;
  remoteDocument?: SemanticDocument;
  receipts?: WhiteboardReceiptEntry[];
  remoteStates?: Map<string, { hash: string }>;
} = {}): Parameters<typeof planWhiteboardPublish>[0] {
  return {
    localDocument: { nodes: [localNode()] },
    remoteDocument: input.remoteDocument ?? { nodes: input.remote ? [input.remote] : [] },
    localAssets: [localAsset('svg-current')],
    discoveryBlockers: [],
    receiptEntries: input.receipts ?? [],
    remoteStates: input.remoteStates ?? new Map(),
    confirmedRemoteOverwrites: new Set()
  };
}

function trackedInput(input: {
  localHash: string;
  remoteHash: string;
  confirmed?: Set<string>;
}): Parameters<typeof planWhiteboardPublish>[0] {
  return {
    localDocument: { nodes: [localNode()] },
    remoteDocument: { nodes: [remoteAsset('whiteboard', 'wb_block', 'wb_token')] },
    localAssets: [localAsset(input.localHash)],
    discoveryBlockers: [],
    receiptEntries: [receipt()],
    remoteStates: new Map([['wb_token', { hash: input.remoteHash }]]),
    confirmedRemoteOverwrites: input.confirmed ?? new Set()
  };
}

function localNode(): SemanticAssetNode {
  return {
    kind: 'asset',
    locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 0 },
    representation: 'image',
    alt: 'CAGRA',
    source: './assets/cagra.png'
  };
}

function localAsset(svgHash: string): LocalWhiteboardAsset {
  return {
    assetKey: 'assets/cagra.png',
    svgKey: 'assets/cagra.svg',
    sourceKind: 'png-sibling',
    locator: localNode().locator,
    alt: 'CAGRA',
    pngPath: '/tmp/assets/cagra.png',
    svgPath: '/tmp/assets/cagra.svg',
    svgSource: '<svg viewBox="0 0 10 10"><text>CAGRA</text></svg>',
    svgHash,
    expectedTexts: ['CAGRA']
  };
}

function remoteAsset(
  representation: SemanticAssetNode['representation'],
  remoteBlockId: string,
  remoteToken: string
): SemanticAssetNode {
  return {
    kind: 'asset',
    locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 0 },
    representation,
    remoteBlockId,
    remoteToken
  };
}

function receipt(): WhiteboardReceiptEntry {
  return {
    assetKey: 'assets/cagra.png',
    pngPath: 'assets/cagra.png',
    svgPath: 'assets/cagra.svg',
    svgHash: 'svg-base',
    whiteboardToken: 'wb_token',
    blockId: 'wb_block',
    remoteStateHash: 'remote-base',
    placementFingerprint: 'placement-base'
  };
}
