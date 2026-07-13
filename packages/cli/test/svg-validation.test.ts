import { describe, expect, it } from 'vitest';
import { validateWhiteboardSvg } from '../src/whiteboards/svg-validation.js';

describe('Whiteboard SVG validation', () => {
  it('accepts editable self-contained shapes, lines, groups, and text', () => {
    const result = validateWhiteboardSvg(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120">
  <g transform="translate(10 10)">
    <rect x="0" y="0" width="120" height="60" fill="#fff"/>
    <text x="60" y="35"><tspan>CAGRA</tspan></text>
    <path d="M 120 30 L 200 30"/>
    <polygon points="200,25 210,30 200,35"/>
  </g>
</svg>`);

    expect(result).toEqual({ valid: true, issues: [], expectedTexts: ['CAGRA'] });
  });

  it.each([
    ['script', '<script>alert(1)</script>'],
    ['foreignObject', '<foreignObject><div>HTML</div></foreignObject>'],
    ['image', '<image href="data:image/png;base64,AA=="/>'],
    ['filter', '<filter id="shadow"></filter>'],
    ['pattern', '<pattern id="dots"></pattern>'],
    ['clipPath', '<clipPath id="clip"><rect width="10" height="10"/></clipPath>'],
    ['mask', '<mask id="mask"><rect width="10" height="10"/></mask>'],
    ['radialGradient', '<radialGradient id="gradient"></radialGradient>'],
    ['unknown element', '<video></video>']
  ])('blocks unsupported %s content', (_name, content) => {
    const result = validateWhiteboardSvg(`<svg viewBox="0 0 10 10">${content}</svg>`);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unsupported-element' }));
  });

  it('blocks external references while allowing local symbol references', () => {
    const external = validateWhiteboardSvg('<svg viewBox="0 0 10 10"><use href="https://example.com/icon.svg#x"/></svg>');
    const local = validateWhiteboardSvg('<svg viewBox="0 0 10 10"><defs><symbol id="x"><rect width="2" height="2"/></symbol></defs><use href="#x"/></svg>');

    expect(external.issues).toContainEqual(expect.objectContaining({ code: 'external-resource' }));
    expect(local.valid).toBe(true);
  });

  it.each(['matrix(1 0 0 1 0 0)', 'skewX(20)', 'skewY(20)'])('blocks unsupported transform %s', (transform) => {
    const result = validateWhiteboardSvg(`<svg viewBox="0 0 10 10"><rect width="2" height="2" transform="${transform}"/></svg>`);

    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unsupported-transform' }));
  });

  it('requires a viewBox', () => {
    const result = validateWhiteboardSvg('<svg><rect width="2" height="2"/></svg>');

    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing-viewbox' }));
  });

  it('rejects malformed XML', () => {
    const result = validateWhiteboardSvg('<svg viewBox="0 0 10 10"><rect></svg>');

    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'malformed-svg' }));
  });
});
