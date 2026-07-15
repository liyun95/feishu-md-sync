import { describe, expect, it } from 'vitest';
import { renderCodeBlockXml } from '../src/code-blocks/code-xml.js';

describe('Code block XML', () => {
  it('escapes Code text and preserves exact newlines', () => {
    expect(renderCodeBlockXml({
      kind: 'code',
      locator: { sectionPath: [], kind: 'code', ordinal: 0 },
      content: 'if (a < b && b > 0) {\n  return "x";\n}\n',
      sourceLanguage: 'js',
      resolvedLanguage: 'javascript',
      issues: []
    })).toBe(
      '<pre lang="javascript"><code>if (a &lt; b &amp;&amp; b &gt; 0) {\n  return "x";\n}\n</code></pre>'
    );
  });

  it('preserves and escapes a remote-owned caption', () => {
    expect(renderCodeBlockXml({
      kind: 'code',
      locator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      content: 'print(1)\n',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      caption: 'A "safe" <example>',
      issues: []
    })).toContain('caption="A &quot;safe&quot; &lt;example&gt;"');
  });
});
