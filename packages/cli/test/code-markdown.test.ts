import { describe, expect, it } from 'vitest';
import { findNextFencedCode, renderFencedCode } from '../src/code-blocks/code-markdown.js';

describe('fenced Code Markdown', () => {
  it.each([
    ['```python\nprint("ok")\n```\n', '`', 3],
    ['~~~~bash\necho ok\n~~~~\n', '~', 4],
    ['`````\nplain\n`````', '`', 5]
  ])('parses matching fences from %j', (source, marker, length) => {
    expect(findNextFencedCode(source)).toMatchObject({
      start: 0,
      end: source.length,
      fenceMarker: marker,
      fenceLength: length
    });
  });

  it('normalizes CRLF and preserves all other Code content exactly', () => {
    const source = '```python\r\n\tif ok:\r\n\r\n  print("x")  \r\n```\r\n';

    expect(findNextFencedCode(source)?.content).toBe('\tif ok:\n\n  print("x")  \n');
  });

  it('keeps HTML-looking content inside the fenced block', () => {
    expect(findNextFencedCode('```html\n<table><tr><td>x</td></tr></table>\n```')?.content).toBe(
      '<table><tr><td>x</td></tr></table>\n'
    );
  });

  it('does not treat a four-space-indented list fence as top-level', () => {
    expect(findNextFencedCode('1. item\n\n    ```python\n    print(1)\n    ```\n')).toBeUndefined();
  });

  it('reports unsupported info-string attributes and unknown languages', () => {
    expect(findNextFencedCode('```python linenums\nprint(1)\n```')?.issues).toEqual([
      expect.objectContaining({ code: 'unsupported-code-info-string' })
    ]);
    expect(findNextFencedCode('```milvusql\nSELECT 1;\n```')?.issues).toEqual([
      expect.objectContaining({ code: 'unsupported-code-language' })
    ]);
  });

  it('reports an unterminated fence', () => {
    expect(findNextFencedCode('```python\nprint(1)\n')?.issues).toEqual([
      expect.objectContaining({ code: 'unsupported-code-info-string', message: 'unterminated fenced Code block' })
    ]);
  });

  it('renders a canonical fence while retaining the exact body', () => {
    expect(renderFencedCode({ sourceLanguage: 'py', content: 'print(1)\n\n' })).toBe(
      '```py\nprint(1)\n\n```'
    );
  });
});
