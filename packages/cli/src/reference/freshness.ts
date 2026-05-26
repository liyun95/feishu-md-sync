export type ReferenceSourceFreshness = {
  sdk: string;
  repository?: string;
  versionLine: string;
  baselineTag: string;
  latestTag: string;
  upToDate: boolean;
  diffRange?: string;
  changedPaths: string[];
  checkedAt: string;
};

export function buildReferenceSourceFreshness(input: {
  sdk: string;
  repository?: string;
  versionLine: string;
  baselineTag: string;
  tags: string[];
  changedPaths?: string[];
  checkedAt?: string;
}): ReferenceSourceFreshness {
  const latestTag = latestMatchingTag(input.tags, input.versionLine);
  if (!latestTag) {
    throw new Error(`No tags match version line ${input.versionLine}.`);
  }

  const upToDate = latestTag === input.baselineTag;
  return {
    sdk: input.sdk,
    repository: input.repository,
    versionLine: input.versionLine,
    baselineTag: input.baselineTag,
    latestTag,
    upToDate,
    diffRange: upToDate ? undefined : `${input.baselineTag}..${latestTag}`,
    changedPaths: input.changedPaths ?? [],
    checkedAt: input.checkedAt ?? new Date().toISOString()
  };
}

export function latestMatchingTag(tags: string[], versionLine: string): string | undefined {
  return tags
    .filter((tag) => tagMatchesVersionLine(tag, versionLine))
    .sort(compareVersionTags)
    .at(-1);
}

export function tagMatchesVersionLine(tag: string, versionLine: string): boolean {
  const line = normalizeVersionLine(versionLine);
  const version = parseTagVersion(tag);
  return Boolean(version && version.major === line.major && version.minor === line.minor);
}

function compareVersionTags(a: string, b: string): number {
  const left = parseTagVersion(a);
  const right = parseTagVersion(b);
  if (!left || !right) return a.localeCompare(b);

  return left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch ||
    a.localeCompare(b);
}

function normalizeVersionLine(versionLine: string): { major: number; minor: number } {
  const match = /^v?(\d+)\.(\d+)\.x$/i.exec(versionLine.trim());
  if (!match) {
    throw new Error(`Invalid version line ${versionLine}. Expected v3.0.x or 3.0.x.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function parseTagVersion(tag: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}
