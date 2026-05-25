export type ReleaseSdk = 'python' | 'java' | 'nodejs' | 'go' | 'rest';

export type SdkSource = {
  sdk: ReleaseSdk;
  label: string;
  repository: string;
};

export type SdkTagRow = {
  sdk: ReleaseSdk;
  label: string;
  repository: string;
  releaseLine: string;
  matchedTag: string | null;
  variablesValue: string | null;
  evidence: string;
  status: 'ok' | 'blocked';
  reason?: string;
};

export type SdkTagMatrix = {
  releaseLine: string;
  generatedAt: string;
  rows: SdkTagRow[];
  blocked: Array<{ sdk: ReleaseSdk; reason: string }>;
};

export type SdkSourceReader = (source: SdkSource) => Promise<string[]>;

export const DEFAULT_SDK_SOURCES: SdkSource[] = [
  { sdk: 'python', label: 'Python', repository: 'pymilvus' },
  { sdk: 'java', label: 'Java', repository: 'milvus-io/milvus-sdk-java' },
  { sdk: 'nodejs', label: 'Node.js', repository: 'milvus-io/milvus-sdk-node' },
  { sdk: 'go', label: 'Go', repository: 'milvus-io/milvus client/' },
  { sdk: 'rest', label: 'REST/server', repository: 'milvus-io/milvus OpenAPI/server' }
];

export async function buildSdkTagMatrix(input: {
  releaseLine: string;
  reader: SdkSourceReader;
  generatedAt?: string;
  sources?: SdkSource[];
}): Promise<SdkTagMatrix> {
  const rows: SdkTagRow[] = [];
  const sources = input.sources ?? DEFAULT_SDK_SOURCES;
  for (const source of sources) {
    try {
      const tags = await input.reader(source);
      const matchedTag = selectReleaseLineTag(tags, input.releaseLine);
      if (!matchedTag) {
        rows.push(blockedRow(source, input.releaseLine, `No tag matched ${input.releaseLine}.`));
        continue;
      }
      rows.push({
        sdk: source.sdk,
        label: source.label,
        repository: source.repository,
        releaseLine: input.releaseLine,
        matchedTag,
        variablesValue: tagToVariablesValue(matchedTag),
        evidence: `${source.repository} tag ${matchedTag}`,
        status: 'ok'
      });
    } catch (error) {
      rows.push(blockedRow(source, input.releaseLine, (error as Error).message));
    }
  }
  return {
    releaseLine: input.releaseLine,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rows,
    blocked: rows
      .filter((row) => row.status === 'blocked')
      .map((row) => ({ sdk: row.sdk, reason: row.reason ?? 'blocked' }))
  };
}

export function selectReleaseLineTag(tags: string[], releaseLine: string): string | null {
  const prefix = releaseLine.replace(/\.x$/, '.');
  const matches = tags.filter((tag) => tag.replace(/^v/, '').startsWith(prefix));
  return matches.sort(compareVersionTags).at(-1) ?? null;
}

export function tagToVariablesValue(tag: string): string {
  return tag.replace(/^v/, '');
}

export function renderSdkTagMatrixMarkdown(matrix: SdkTagMatrix): string {
  const lines = [
    `# SDK Tag Matrix`,
    ``,
    `Release line: ${matrix.releaseLine}`,
    ``,
    `| SDK | Repository | Matched tag | Variables value | Status | Evidence |`,
    `| --- | --- | --- | --- | --- | --- |`
  ];
  for (const row of matrix.rows) {
    lines.push(
      `| ${row.sdk} | ${row.repository} | ${row.matchedTag ?? ''} | ${row.variablesValue ?? ''} | ${row.status} | ${
        row.reason ?? row.evidence
      } |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function blockedRow(source: SdkSource, releaseLine: string, reason: string): SdkTagRow {
  return {
    sdk: source.sdk,
    label: source.label,
    repository: source.repository,
    releaseLine,
    matchedTag: null,
    variablesValue: null,
    evidence: '',
    status: 'blocked',
    reason
  };
}

function compareVersionTags(left: string, right: string): number {
  const a = left.replace(/^v/, '').split('.').map((value) => Number.parseInt(value, 10));
  const b = right.replace(/^v/, '').split('.').map((value) => Number.parseInt(value, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.localeCompare(right);
}
