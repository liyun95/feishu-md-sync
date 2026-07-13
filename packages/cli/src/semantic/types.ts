export type SemanticMarks = {
  bold?: true;
  italic?: true;
  code?: true;
  link?: string;
};

export type SemanticInline =
  | { kind: 'text'; value: string; marks?: SemanticMarks }
  | { kind: 'break' };

export type SemanticParagraph = {
  kind: 'paragraph';
  inlines: SemanticInline[];
};

export type SemanticList = {
  kind: 'list';
  ordered: boolean;
  items: SemanticInline[][];
};

export type SemanticCellBlock = SemanticParagraph | SemanticList;

export type SemanticCell = {
  blocks: SemanticCellBlock[];
};

export type SemanticLocator = {
  sectionPath: string[];
  kind: 'text' | 'table' | 'opaque';
  ordinal: number;
};

export type SemanticRow = {
  key: string;
  cells: SemanticCell[];
};

export type SemanticTable = {
  kind: 'table';
  locator: SemanticLocator;
  headers: SemanticCell[];
  rows: SemanticRow[];
  remoteBlockId?: string;
  unsupported: string[];
};

export type SemanticTextBlock = {
  kind: 'text';
  locator: SemanticLocator;
  blockType: number;
  markdown: string;
  remoteBlockId?: string;
};

export type SemanticOpaqueNode = {
  kind: 'opaque';
  locator: SemanticLocator;
  description: string;
  fingerprint: string;
  remoteBlockId?: string;
};

export type SemanticNode = SemanticTextBlock | SemanticTable | SemanticOpaqueNode;

export type SemanticDocument = {
  nodes: SemanticNode[];
};
