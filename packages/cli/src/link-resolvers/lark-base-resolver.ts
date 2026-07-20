import type {
  FeishuAdapter,
  RemoteBaseRecord
} from '../adapters/feishu-adapter.js';
import type { DialectDiagnostic } from '../dialects/types.js';
import type { LarkBaseLinkCache } from './cache.js';
import type {
  DocumentLinkResolver,
  LarkBaseLinkResolverConfig,
  LinkResolutionSource
} from './types.js';

type BaseLinkEntry = LarkBaseLinkCache['entries'][number];

export async function refreshLarkBaseLinkEntries(input: {
  adapter: FeishuAdapter;
  baseToken: string;
  config: LarkBaseLinkResolverConfig;
}): Promise<BaseLinkEntry[]> {
  if (!input.adapter.fetchBaseTables || !input.adapter.fetchBaseRecords) {
    throw new Error('The configured Feishu adapter does not support read-only Base access.');
  }
  const fields = uniqueStrings([
    input.config.keyField,
    input.config.urlField,
    input.config.placementTypeField,
    input.config.referenceField
  ]);
  const accepted = new Set(input.config.acceptedPlacementTypes.map(normalizePlacementType));
  const tables = await input.adapter.fetchBaseTables({ baseToken: input.baseToken });
  const entries: BaseLinkEntry[] = [];

  for (const table of tables) {
    const records = await input.adapter.fetchBaseRecords({
      baseToken: input.baseToken,
      tableId: table.id,
      fields
    });
    for (const record of records) {
      const placementType = placementTypeFromRecord(record, input.config.placementTypeField);
      if (!placementType || !accepted.has(placementType)) continue;
      const slug = normalizeDocumentSlug(scalarString(record.fields[input.config.keyField]));
      const url = extractFeishuDocumentUrl(record.fields[input.config.urlField]);
      if (!slug || !url) continue;
      entries.push({
        slug,
        url,
        placementType,
        tableId: table.id,
        tableName: table.name,
        recordId: record.recordId
      });
    }
  }
  return deduplicateEntries(entries);
}

export function createLarkBaseDocumentLinkResolver(input: {
  entries: BaseLinkEntry[];
  source: LinkResolutionSource;
  warnings?: DialectDiagnostic[];
  slugAliases?: Record<string, string>;
}): DocumentLinkResolver {
  const bySlug = new Map<string, BaseLinkEntry[]>();
  for (const entry of input.entries) {
    const candidates = bySlug.get(entry.slug) ?? [];
    candidates.push(entry);
    bySlug.set(entry.slug, candidates);
  }
  const aliases = new Map(Object.entries(input.slugAliases ?? {}).flatMap(([source, target]) => {
    const normalizedSource = normalizeDocumentSlug(source);
    const normalizedTarget = normalizeDocumentSlug(target);
    return normalizedSource && normalizedTarget ? [[normalizedSource, normalizedTarget]] : [];
  }));
  return {
    async resolve(request) {
      const slug = normalizeDocumentSlug(request.slug);
      const lookupSlug = slug && (bySlug.get(slug)?.length ?? 0) > 0
        ? slug
        : slug ? aliases.get(slug) ?? slug : undefined;
      const candidates = lookupSlug ? bySlug.get(lookupSlug) ?? [] : [];
      const urls = [...new Set(candidates.map(({ url }) => url))];
      if (urls.length > 1) {
        return {
          diagnostics: [
            ...(input.warnings ?? []),
            ambiguousDiagnostic(slug ?? request.slug, candidates, request.location)
          ]
        };
      }
      if (urls.length === 0) {
        return { diagnostics: [...(input.warnings ?? [])] };
      }
      return {
        resolved: {
          originalUrl: request.originalUrl,
          slug: slug ?? request.slug,
          resolvedUrl: urls[0]!,
          source: input.source,
          location: request.location
        },
        diagnostics: [...(input.warnings ?? [])]
      };
    }
  };
}

export function extractFeishuDocumentUrl(value: unknown): string | undefined {
  const text = scalarString(value)?.trim();
  if (!text) return undefined;
  const markdown = text.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/);
  const candidate = markdown?.[1] ?? text;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (!/\.(?:feishu\.cn|larksuite\.com)$/i.test(`.${url.hostname}`)) return undefined;
  if (!/^\/(?:wiki|docx)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return undefined;
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function normalizeDocumentSlug(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^\/+|\/+$/g, '').replace(/^docs\//, '');
  return normalized || undefined;
}

function placementTypeFromRecord(record: RemoteBaseRecord, field: string): string | undefined {
  const value = record.fields[field];
  const scalar = Array.isArray(value) ? value[0] : value;
  return typeof scalar === 'string' ? normalizePlacementType(scalar) : undefined;
}

function normalizePlacementType(value: string): string {
  return value.trim().toLowerCase();
}

function scalarString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function deduplicateEntries(entries: BaseLinkEntry[]): BaseLinkEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.slug}\0${entry.url}\0${entry.placementType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ambiguousDiagnostic(
  slug: string,
  candidates: BaseLinkEntry[],
  location: { file: string; line: number; column?: number }
): DialectDiagnostic {
  const details = candidates.map((candidate) => {
    return `${candidate.tableName}/${candidate.recordId} (${candidate.placementType}): ${candidate.url}`;
  }).join('; ');
  return {
    code: 'relative-link-ambiguous',
    severity: 'blocker',
    message: `Multiple Feishu document mappings exist for ${slug}: ${details}`,
    location
  };
}
