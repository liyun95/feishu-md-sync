import { describe, expect, it } from 'vitest';
import {
  canonicalWhiteboardRaw,
  verifyWhiteboardReadback,
  whiteboardRemoteStateHash
} from '../src/whiteboards/remote-state.js';

describe('remote Whiteboard state', () => {
  it('canonicalizes object keys while preserving array order', () => {
    const left = { nodes: [{ z: 2, a: 1 }, { id: 'second' }], version: 1 };
    const same = { version: 1, nodes: [{ a: 1, z: 2 }, { id: 'second' }] };
    const reordered = { version: 1, nodes: [{ id: 'second' }, { a: 1, z: 2 }] };

    expect(canonicalWhiteboardRaw(left)).toBe(canonicalWhiteboardRaw(same));
    expect(whiteboardRemoteStateHash(left)).toBe(whiteboardRemoteStateHash(same));
    expect(whiteboardRemoteStateHash(left)).not.toBe(whiteboardRemoteStateHash(reordered));
  });

  it('accepts non-empty raw state containing all expected SVG text', () => {
    expect(() => verifyWhiteboardReadback({
      raw: { nodes: [{ shape: { text: 'CAGRA' } }, { text: { content: 'Search path' } }] },
      expectedTexts: ['CAGRA', 'Search path']
    })).not.toThrow();
  });

  it.each([null, {}, [], { nodes: [] }])('rejects empty raw state %#', (raw) => {
    expect(() => verifyWhiteboardReadback({ raw, expectedTexts: [] }))
      .toThrow('Whiteboard readback returned no nodes');
  });

  it('rejects readback missing expected SVG text', () => {
    expect(() => verifyWhiteboardReadback({
      raw: { nodes: [{ text: 'Different label' }] },
      expectedTexts: ['CAGRA']
    })).toThrow('Whiteboard readback is missing expected text: CAGRA');
  });
});
