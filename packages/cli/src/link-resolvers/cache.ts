import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256, stableStringify } from '../core/hash.js';
import type { LarkBaseLinkResolverConfig } from './types.js';

export const LINK_RESOLVER_CACHE_TTL_MS = 60 * 60 * 1000;

export type LarkBaseLinkCache = {
  version: 1;
  baseToken: string;
  resolverFingerprint: string;
  fetchedAt: string;
  entries: Array<{
    slug: string;
    url: string;
    placementType: string;
    tableId: string;
    tableName: string;
    recordId: string;
  }>;
};

export function resolverFingerprint(config: LarkBaseLinkResolverConfig): string {
  return sha256(stableStringify({
    keyField: config.keyField,
    urlField: config.urlField,
    placementTypeField: config.placementTypeField,
    referenceField: config.referenceField,
    acceptedPlacementTypes: [...config.acceptedPlacementTypes].sort(),
    slugAliases: Object.fromEntries(
      Object.entries(config.slugAliases ?? {}).sort(([left], [right]) => left.localeCompare(right))
    )
  }));
}

export function linkResolverCachePath(input: {
  cwd: string;
  baseToken: string;
  config: LarkBaseLinkResolverConfig;
}): string {
  const key = sha256(stableStringify({
    baseToken: input.baseToken,
    resolverFingerprint: resolverFingerprint(input.config)
  }));
  return join(input.cwd, '.sync', 'feishu-md-sync', 'link-resolvers', `${key}.json`);
}

export async function readLinkResolverCache(path: string): Promise<LarkBaseLinkCache | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return isLarkBaseLinkCache(parsed) ? parsed : undefined;
}

export function isFreshLinkResolverCache(input: {
  cache: LarkBaseLinkCache;
  now: Date;
}): boolean {
  const fetchedAt = Date.parse(input.cache.fetchedAt);
  return Number.isFinite(fetchedAt) &&
    input.now.getTime() - fetchedAt < LINK_RESOLVER_CACHE_TTL_MS;
}

export async function writeLinkResolverCache(input: {
  path: string;
  cache: LarkBaseLinkCache;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  const temporaryPath = `${input.path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(input.cache, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, input.path);
}

function isLarkBaseLinkCache(value: unknown): value is LarkBaseLinkCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cache = value as Partial<LarkBaseLinkCache>;
  return cache.version === 1 &&
    typeof cache.baseToken === 'string' &&
    typeof cache.resolverFingerprint === 'string' &&
    typeof cache.fetchedAt === 'string' &&
    Array.isArray(cache.entries) &&
    cache.entries.every((entry) => {
      return Boolean(
        entry &&
        typeof entry.slug === 'string' &&
        typeof entry.url === 'string' &&
        typeof entry.placementType === 'string' &&
        typeof entry.tableId === 'string' &&
        typeof entry.tableName === 'string' &&
        typeof entry.recordId === 'string'
      );
    });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
