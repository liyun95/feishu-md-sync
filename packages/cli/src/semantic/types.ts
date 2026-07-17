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
  kind: 'text' | 'code' | 'table' | 'asset' | 'callout' | 'opaque' | 'authoring-token' | 'protected-resource';
  ordinal: number;
  textPath?: number[];
};

export type SemanticAuthoringToken = {
  kind: 'authoring-token';
  locator: SemanticLocator;
  component: 'Procedures';
  token: 'open' | 'close';
  markdown: '<Procedures>' | '</Procedures>';
  remoteBlockId?: string;
};

export type SemanticProtectedResource = {
  kind: 'protected-resource';
  locator: SemanticLocator;
  resourceKind: 'supademo';
  componentId?: string;
  remoteBlockId?: string;
  remoteToken?: string;
  remoteShape?: string;
};

export type SemanticCodeBlock = {
  kind: 'code';
  locator: SemanticLocator;
  content: string;
  sourceLanguage: string;
  resolvedLanguage: string;
  caption?: string;
  remoteBlockId?: string;
  issues: Array<{
    code: 'unsupported-code-language' | 'unsupported-code-info-string';
    message: string;
  }>;
};

export type CalloutType = 'note' | 'warning';

export type SemanticCalloutChild = {
  ordinal: number;
  blockType: number;
  markdown: string;
  remoteBlockId?: string;
};

export type SemanticCallout = {
  kind: 'callout';
  locator: SemanticLocator;
  calloutType?: CalloutType;
  titleManaged?: true;
  title?: {
    markdown: string;
    remoteBlockId?: string;
  };
  children: SemanticCalloutChild[];
  remoteBlockId?: string;
  shell?: {
    emojiId?: string;
    backgroundColor?: number;
    borderColor?: number;
    textColor?: number;
  };
  unsupported: string[];
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
  children?: SemanticTextChild[];
};

export type SemanticTextChild = {
  blockType: number;
  markdown: string;
  remoteBlockId?: string;
  children?: SemanticTextChild[];
};

export type SemanticOpaqueNode = {
  kind: 'opaque';
  locator: SemanticLocator;
  description: string;
  fingerprint: string;
  remoteBlockId?: string;
};

export type SemanticAssetNode = {
  kind: 'asset';
  locator: SemanticLocator;
  representation: 'image' | 'whiteboard';
  alt?: string;
  source?: string;
  remoteBlockId?: string;
  remoteToken?: string;
  unsupported?: string[];
};

export type SemanticNode = SemanticTextBlock | SemanticCodeBlock | SemanticTable | SemanticAssetNode |
  SemanticCallout | SemanticOpaqueNode | SemanticAuthoringToken | SemanticProtectedResource;

export type SemanticDocument = {
  nodes: SemanticNode[];
};
