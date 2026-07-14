import { describe, expect, it } from 'vitest';
import {
  canonicalWhiteboardRaw,
  verifyWhiteboardReadback,
  whiteboardRemoteStateHash
} from '../src/whiteboards/remote-state.js';

describe('remote Whiteboard state', () => {
  it('canonicalizes object keys and Whiteboard node order by stable node ID', () => {
    const left = { nodes: [{ id: 'first', z: 2, a: 1 }, { id: 'second' }], version: 1 };
    const same = { version: 1, nodes: [{ a: 1, id: 'first', z: 2 }, { id: 'second' }] };
    const reordered = { version: 1, nodes: [{ id: 'second' }, { id: 'first', a: 1, z: 2 }] };

    expect(canonicalWhiteboardRaw(left)).toBe(canonicalWhiteboardRaw(same));
    expect(whiteboardRemoteStateHash(left)).toBe(whiteboardRemoteStateHash(same));
    expect(whiteboardRemoteStateHash(left)).toBe(whiteboardRemoteStateHash(reordered));
  });

  it('preserves order for arrays without stable node identities', () => {
    const left = { nodes: [{ id: 'connector', turningPoints: [{ x: 1 }, { x: 2 }] }] };
    const reordered = { nodes: [{ id: 'connector', turningPoints: [{ x: 2 }, { x: 1 }] }] };

    expect(whiteboardRemoteStateHash(left)).not.toBe(whiteboardRemoteStateHash(reordered));
  });

  it('accepts non-empty raw state containing all expected SVG text', () => {
    expect(() => verifyWhiteboardReadback({
      raw: { nodes: [
        { id: 'text-1', type: 'text_shape', text: { text: 'CAGRA' } },
        { id: 'text-2', type: 'text_shape', text: { text: 'Search path' } }
      ] },
      expectedTexts: ['CAGRA', 'Search path']
    })).not.toThrow();
  });

  it.each([null, {}, [], { nodes: [] }, { nodes: [], version: 1 }])('rejects empty raw state %#', (raw) => {
    expect(() => verifyWhiteboardReadback({ raw, expectedTexts: [] }))
      .toThrow('Whiteboard readback returned no nodes');
  });

  it('does not accept expected text found only in arbitrary metadata', () => {
    expect(() => verifyWhiteboardReadback({
      raw: { nodes: [{ id: 'shape-1', type: 'composite_shape', metadata: { name: 'CAGRA' } }] },
      expectedTexts: ['CAGRA']
    })).toThrow('Whiteboard readback is missing expected text: CAGRA');
  });

  it('does not accept text on a non-text node', () => {
    expect(() => verifyWhiteboardReadback({
      raw: { nodes: [{ id: 'shape-1', type: 'composite_shape', text: 'CAGRA' }] },
      expectedTexts: ['CAGRA']
    })).toThrow('Whiteboard readback is missing expected text: CAGRA');
  });

  it('rejects readback missing expected SVG text', () => {
    expect(() => verifyWhiteboardReadback({
      raw: { nodes: [{ text: 'Different label' }] },
      expectedTexts: ['CAGRA']
    })).toThrow('Whiteboard readback is missing expected text: CAGRA');
  });
});
