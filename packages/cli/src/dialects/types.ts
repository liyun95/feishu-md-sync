export const DIALECT_NAMES = ['gfm', 'docusaurus', 'milvus-authoring'] as const;

export type DialectName = typeof DIALECT_NAMES[number];

export type SourceLocation = {
  file: string;
  line: number;
  column?: number;
};

export type DialectDiagnosticCode =
  | 'dialect-suggestion'
  | 'unsupported-mdx-component'
  | 'unsupported-docusaurus-admonition'
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
