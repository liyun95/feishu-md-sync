const DOC_ID_PATTERN = /^[A-Za-z0-9]{16,}$/;

export type FeishuTarget =
  | { kind: 'docx'; token: string }
  | { kind: 'wiki'; token: string }
  | { kind: 'folder'; token: string };

export function parseFeishuDocId(input: string): string {
  const target = parseFeishuTarget(input);
  if (target.kind !== 'docx') {
    throw new Error(`Wiki URL requires API resolution before it can be used as a docx document: ${input}`);
  }
  return target.token;
}

export function parseFeishuTarget(input: string): FeishuTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Feishu document ID or URL is required.');
  }

  if (DOC_ID_PATTERN.test(trimmed)) {
    return { kind: 'docx', token: trimmed };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Feishu document ID or URL: ${input}`);
  }

  const docxMatch = url.pathname.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch) {
    return { kind: 'docx', token: docxMatch[1] };
  }

  const docsMatch = url.pathname.match(/\/docs\/([A-Za-z0-9]+)/);
  if (docsMatch) {
    return { kind: 'docx', token: docsMatch[1] };
  }

  const wikiMatch = url.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) {
    return { kind: 'wiki', token: wikiMatch[1] };
  }

  const folderMatch = url.pathname.match(/\/drive\/folder\/([A-Za-z0-9]+)/);
  if (folderMatch) {
    return { kind: 'folder', token: folderMatch[1] };
  }

  throw new Error(`Could not find a supported Feishu token in URL: ${input}`);
}
