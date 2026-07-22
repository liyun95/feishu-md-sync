export type ZdocComponentStatus = 'preserved' | 'transformed' | 'blocking';

type ZdocComponentBase = {
  sourceLine: number;
  sectionPath: string[];
  status: ZdocComponentStatus;
};

export type ZdocProceduresComponent = ZdocComponentBase & {
  kind: 'procedures';
  token: 'open' | 'close';
};

export type ZdocSupademoComponent = ZdocComponentBase & {
  kind: 'supademo';
  componentId: string;
  isShowcase: boolean;
};

export type ZdocAdmonitionComponent = ZdocComponentBase & {
  kind: 'admonition';
  title: string;
  calloutType: 'note' | 'warning';
};

export type ZdocUnknownComponent = ZdocComponentBase & {
  kind: 'unknown';
  componentName: string;
};

export type ZdocComponent =
  | ZdocProceduresComponent
  | ZdocSupademoComponent
  | ZdocAdmonitionComponent
  | ZdocUnknownComponent;

export type ZdocIgnoredMetadata = {
  kind: 'frontmatter' | 'import' | 'heading-anchor';
  sourceLine: number;
};

export type ZdocComponentInventory = {
  components: ZdocComponent[];
  ignoredMetadata: ZdocIgnoredMetadata[];
};

export type ZdocRoundTripItemCode =
  | 'procedures-preserved'
  | 'procedures-create'
  | 'procedures-move'
  | 'procedures-delete'
  | 'procedures-invalid'
  | 'supademo-adopt'
  | 'supademo-protected'
  | 'supademo-missing'
  | 'supademo-ambiguous'
  | 'supademo-changed'
  | 'supademo-removed'
  | 'admonition-transform'
  | 'round-trip-loss-repair'
  | 'round-trip-loss-drift'
  | 'round-trip-loss-ambiguous'
  | 'metadata-ignored'
  | 'component-unsupported';

export type ZdocRoundTripItem = {
  code: ZdocRoundTripItemCode;
  severity: 'info' | 'warning' | 'blocker';
  component: string;
  message: string;
  sourceLine?: number;
  remoteBlockId?: string;
};

export type ZdocRoundTripReport = {
  safeToPublish: boolean;
  items: ZdocRoundTripItem[];
};
