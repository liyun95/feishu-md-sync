import type { DialectDiagnostic, SourceLocation } from '../dialects/types.js';

export type LarkBaseLinkResolverConfig = {
  type: 'lark-base';
  baseUrl: string;
  keyField: string;
  urlField: string;
  placementTypeField: string;
  referenceField?: string;
  acceptedPlacementTypes: string[];
  slugAliases?: Record<string, string>;
};

export type DialectWorkspaceConfig = {
  sourceRoot?: string;
  publicSiteBaseUrl?: string;
  linkResolver?: LarkBaseLinkResolverConfig;
};

export type LinkResolutionSource = 'live-base' | 'fresh-cache' | 'stale-cache' | 'public-site';

export type ResolvedDocumentLink = {
  originalUrl: string;
  slug: string;
  resolvedUrl: string;
  source: LinkResolutionSource;
  location: SourceLocation;
};

export type LinkResolutionSummary = {
  resolvedToFeishu: number;
  resolvedFromFreshCache: number;
  resolvedFromStaleCache: number;
  resolvedToPublicSite: number;
  unresolved: number;
};

export type DocumentLinkResolution = {
  resolved?: ResolvedDocumentLink;
  diagnostics: DialectDiagnostic[];
};

export type DocumentLinkResolver = {
  resolve(input: {
    slug: string;
    originalUrl: string;
    location: SourceLocation;
  }): Promise<DocumentLinkResolution>;
};
