const ESCAPED_HTML_ENTITIES: Array<[RegExp, string]> = [
  [/\\&amp;/g, '&'],
  [/\\&lt;/g, '<'],
  [/\\&gt;/g, '>'],
  [/\\&quot;/g, '"'],
  [/\\&#34;/g, '"'],
  [/\\&\\#34;/g, '"'],
  [/\\&#39;/g, "'"],
  [/\\&\\#39;/g, "'"],
  [/\\&apos;/g, "'"]
];

const COMMONMARK_ESCAPED_PUNCTUATION = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

export function normalizeOfficialMarkdownExport(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  return lines.map((line) => {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return decodeEscapedHtmlEntities(line).replace(COMMONMARK_ESCAPED_PUNCTUATION, '$1');
  }).join('\n');
}

function decodeEscapedHtmlEntities(value: string): string {
  return ESCAPED_HTML_ENTITIES.reduce((current, [pattern, replacement]) => {
    return current.replace(pattern, replacement);
  }, value);
}
