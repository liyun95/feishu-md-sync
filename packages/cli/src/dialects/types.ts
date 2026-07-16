import type {
  LinkResolutionSummary,
  ResolvedDocumentLink
} from '../link-resolvers/types.js';
import type { ZdocComponentInventory } from '../zdoc/types.js';

export const DIALECT_NAMES = ['gfm', 'zdoc-authoring', 'milvus-authoring'] as const;

export type DialectName = typeof DIALECT_NAMES[number];

export type SourceLocation = {
  file: string;
  line: number;
  column?: number;
};

export type DialectDiagnosticCode =
  | 'dialect-suggestion'
  | 'unsupported-mdx-component'
  | 'unsupported-zdoc-admonition'
  | 'zdoc-procedures-unpaired'
  | 'zdoc-procedures-nested'
  | 'zdoc-admonition-unsupported'
  | 'zdoc-component-unsupported'
  | 'missing-milvus-variable'
  | 'missing-milvus-fragment'
  | 'milvus-fragment-cycle'
  | 'unsupported-milvus-directive'
  | 'relative-link-public-fallback'
  | 'relative-link-unresolved'
  | 'relative-link-ambiguous'
  | 'link-resolver-unavailable'
  | 'link-resolver-stale-cache'
  | 'non-gfm-merge-unsupported';

export type DialectDiagnostic = {
  code: DialectDiagnosticCode;
  severity: 'warning' | 'blocker';
  message: string;
  location?: SourceLocation;
  referenceChain?: SourceLocation[];
};

export type DialectDependency = {
  kind: 'file' | 'lark-base' | 'cache';
  identity: string;
  fingerprint: string;
};

export type DialectResult = {
  dialect: DialectName;
  markdown: string;
  metadata: Record<string, unknown>;
  warnings: DialectDiagnostic[];
  blockers: DialectDiagnostic[];
  dependencies: DialectDependency[];
  resolvedLinks: ResolvedDocumentLink[];
  linkResolution: LinkResolutionSummary;
  zdoc?: {
    inventory: ZdocComponentInventory;
  };
};
