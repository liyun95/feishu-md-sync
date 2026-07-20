import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import { sha256, stableStringify } from '../core/hash.js';
import type {
  DialectDependency,
  DialectDiagnostic
} from '../dialects/types.js';
import {
  isFreshLinkResolverCache,
  linkResolverCachePath,
  readLinkResolverCache,
  resolverFingerprint,
  writeLinkResolverCache,
  type LarkBaseLinkCache
} from './cache.js';
import {
  createLarkBaseDocumentLinkResolver,
  refreshLarkBaseLinkEntries
} from './lark-base-resolver.js';
import type {
  DocumentLinkResolver,
  LarkBaseLinkResolverConfig
} from './types.js';

export async function createDocumentLinkResolver(input: {
  cwd: string;
  config?: LarkBaseLinkResolverConfig;
  adapter: FeishuAdapter;
  now?: Date;
}): Promise<{
  resolver?: DocumentLinkResolver;
  dependencies: DialectDependency[];
  warnings: DialectDiagnostic[];
}> {
  if (!input.config) return { dependencies: [], warnings: [] };
  const now = input.now ?? new Date();
  const exposedToken = baseTokenFromUrl(input.config.baseUrl);
  let baseToken = exposedToken;
  let cachePath = baseToken
    ? linkResolverCachePath({ cwd: input.cwd, baseToken, config: input.config })
    : undefined;
  let cache = cachePath ? await readLinkResolverCache(cachePath) : undefined;
  if (cache && cache.resolverFingerprint !== resolverFingerprint(input.config)) cache = undefined;

  if (cache && isFreshLinkResolverCache({ cache, now })) {
    return resolverResult({ cache, cachePath: cachePath!, source: 'fresh-cache', config: input.config });
  }

  try {
    if (!input.adapter.resolveBaseUrl) {
      throw new Error('The configured Feishu adapter does not support Base URL resolution.');
    }
    const resolved = await input.adapter.resolveBaseUrl({ url: input.config.baseUrl });
    baseToken = resolved.baseToken;
    cachePath = linkResolverCachePath({ cwd: input.cwd, baseToken, config: input.config });
    if (!cache) cache = await readLinkResolverCache(cachePath);
    const entries = await refreshLarkBaseLinkEntries({
      adapter: input.adapter,
      baseToken,
      config: input.config
    });
    const refreshed: LarkBaseLinkCache = {
      version: 1,
      baseToken,
      resolverFingerprint: resolverFingerprint(input.config),
      fetchedAt: now.toISOString(),
      entries
    };
    await writeLinkResolverCache({ path: cachePath, cache: refreshed });
    return resolverResult({ cache: refreshed, cachePath, source: 'live-base', config: input.config });
  } catch (error) {
    if (cache && cachePath) {
      const warning = staleCacheWarning(cache, error);
      return resolverResult({
        cache,
        cachePath,
        source: 'stale-cache',
        config: input.config,
        warnings: [warning]
      });
    }
    return {
      dependencies: [],
      warnings: [{
        code: 'link-resolver-unavailable',
        severity: 'warning',
        message: `Feishu Base link resolver is unavailable: ${errorMessage(error)}`
      }]
    };
  }
}

function resolverResult(input: {
  cache: LarkBaseLinkCache;
  cachePath: string;
  source: 'live-base' | 'fresh-cache' | 'stale-cache';
  config: LarkBaseLinkResolverConfig;
  warnings?: DialectDiagnostic[];
}): {
  resolver: DocumentLinkResolver;
  dependencies: DialectDependency[];
  warnings: DialectDiagnostic[];
} {
  const warnings = input.warnings ?? [];
  return {
    resolver: createLarkBaseDocumentLinkResolver({
      entries: input.cache.entries,
      source: input.source,
      warnings,
      slugAliases: input.config.slugAliases
    }),
    dependencies: [
      {
        kind: 'lark-base',
        identity: input.cache.baseToken,
        fingerprint: input.cache.resolverFingerprint
      },
      {
        kind: 'cache',
        identity: input.cachePath,
        fingerprint: sha256(stableStringify(input.cache))
      }
    ],
    warnings
  };
}

function baseTokenFromUrl(value: string): string | undefined {
  try {
    const match = new URL(value).pathname.match(/^\/base\/([A-Za-z0-9_-]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function staleCacheWarning(cache: LarkBaseLinkCache, error: unknown): DialectDiagnostic {
  return {
    code: 'link-resolver-stale-cache',
    severity: 'warning',
    message: `Using cached Feishu Base mappings from ${cache.fetchedAt} because refresh failed: ${errorMessage(error)}`
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
