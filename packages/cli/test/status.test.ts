import { describe, expect, it } from 'vitest';
import { computeSyncStatus } from '../src/sync/status.js';

describe('computeSyncStatus', () => {
  it('reports no-receipt when there is no baseline', () => {
    expect(computeSyncStatus({
      sourceHash: 'source-a',
      desiredHash: 'remote-a',
      currentRemoteHash: 'remote-a',
      receipt: null
    })).toEqual({
      localChanged: true,
      remoteChanged: false,
      state: 'no-receipt'
    });
  });

  it('reports clean when local and remote match receipt', () => {
    expect(computeSyncStatus({
      sourceHash: 'source-a',
      desiredHash: 'remote-a',
      currentRemoteHash: 'remote-a',
      receipt: {
        sourceHash: 'source-a',
        feishuStateHash: 'remote-a'
      }
    })).toEqual({
      localChanged: false,
      remoteChanged: false,
      state: 'clean'
    });
  });

  it('reports local-only changes', () => {
    expect(computeSyncStatus({
      sourceHash: 'source-b',
      desiredHash: 'remote-b',
      currentRemoteHash: 'remote-a',
      receipt: {
        sourceHash: 'source-a',
        feishuStateHash: 'remote-a'
      }
    })).toMatchObject({
      localChanged: true,
      remoteChanged: false,
      state: 'local-changed'
    });
  });

  it('reports remote-only changes', () => {
    expect(computeSyncStatus({
      sourceHash: 'source-a',
      desiredHash: 'remote-b',
      currentRemoteHash: 'remote-b',
      receipt: {
        sourceHash: 'source-a',
        feishuStateHash: 'remote-a'
      }
    })).toMatchObject({
      localChanged: false,
      remoteChanged: true,
      state: 'remote-changed'
    });
  });

  it('reports divergent changes when both sides changed', () => {
    expect(computeSyncStatus({
      sourceHash: 'source-b',
      desiredHash: 'remote-c',
      currentRemoteHash: 'remote-b',
      receipt: {
        sourceHash: 'source-a',
        feishuStateHash: 'remote-a'
      }
    })).toMatchObject({
      localChanged: true,
      remoteChanged: true,
      state: 'diverged'
    });
  });
});
