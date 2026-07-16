import type {
  ZdocComponentInventory,
  ZdocRoundTripItem,
  ZdocRoundTripReport
} from './types.js';
import type {
  ProceduresOperation,
  ProceduresPlanBlocker
} from './procedures-plan.js';

export function buildZdocRoundTripReport(input: {
  inventory: ZdocComponentInventory;
  procedures: {
    operations: ProceduresOperation[];
    blockers: ProceduresPlanBlocker[];
  };
  protectedResources?: {
    items: ZdocRoundTripItem[];
    blockers: Array<{ code: string; message: string }>;
  };
}): ZdocRoundTripReport {
  const items: ZdocRoundTripItem[] = [];

  for (const metadata of input.inventory.ignoredMetadata) {
    items.push({
      code: 'metadata-ignored',
      severity: 'info',
      component: metadata.kind,
      message: `${metadata.kind} is intentionally omitted from the Feishu body`,
      sourceLine: metadata.sourceLine
    });
  }

  for (const component of input.inventory.components) {
    if (component.kind === 'admonition') {
      items.push({
        code: 'admonition-transform',
        severity: component.status === 'blocking' ? 'blocker' : 'info',
        component: 'Admonition',
        message: component.status === 'blocking'
          ? `Admonition "${component.title}" cannot be transformed safely`
          : `transform Admonition "${component.title}" to a native Feishu Callout`,
        sourceLine: component.sourceLine
      });
      continue;
    }
    if (component.kind === 'unknown') {
      items.push({
        code: 'component-unsupported',
        severity: 'blocker',
        component: component.componentName,
        message: `unsupported Zdoc component <${component.componentName}>`,
        sourceLine: component.sourceLine
      });
    }
  }

  const procedures = input.inventory.components.filter((component) => {
    return component.kind === 'procedures';
  });
  if (procedures.some((component) => component.status === 'blocking')) {
    items.push({
      code: 'procedures-invalid',
      severity: 'blocker',
      component: 'Procedures',
      message: 'Procedures tokens are unpaired or nested',
      sourceLine: procedures.find((component) => component.status === 'blocking')?.sourceLine
    });
  }
  for (const blocker of input.procedures.blockers) {
    items.push({
      code: 'procedures-invalid',
      severity: 'blocker',
      component: 'Procedures',
      message: blocker.message
    });
  }
  for (const operation of input.procedures.operations) {
    if (operation.kind === 'authoring-token-create') {
      items.push({
        code: 'procedures-create',
        severity: 'info',
        component: 'Procedures',
        message: `create ${operation.token} at the canonical boundary`
      });
    } else if (operation.kind === 'authoring-token-move') {
      items.push({
        code: 'procedures-move',
        severity: 'warning',
        component: 'Procedures',
        message: `move ${operation.token} to the canonical boundary`,
        remoteBlockId: operation.remoteBlockId
      });
    } else if (operation.kind === 'authoring-token-delete') {
      items.push({
        code: 'procedures-delete',
        severity: 'warning',
        component: 'Procedures',
        message: `delete remote ${operation.token} because the canonical source removed the complete pair`,
        remoteBlockId: operation.remoteBlockId
      });
    }
  }
  if (procedures.length > 0 && input.procedures.operations.length === 0 &&
    input.procedures.blockers.length === 0 &&
    !procedures.some((component) => component.status === 'blocking')) {
    items.push({
      code: 'procedures-preserved',
      severity: 'info',
      component: 'Procedures',
      message: 'Procedures tokens and boundaries are preserved'
    });
  }

  const supademos = input.inventory.components.filter((component) => {
    return component.kind === 'supademo';
  });
  if (input.protectedResources) {
    items.push(...input.protectedResources.items);
    for (const blocker of input.protectedResources.blockers) {
      items.push({
        code: blocker.code === 'supademo-ambiguous'
          ? 'supademo-ambiguous'
          : blocker.code === 'supademo-changed'
            ? 'supademo-changed'
            : blocker.code === 'supademo-removed'
              ? 'supademo-removed'
            : 'supademo-missing',
        severity: 'blocker',
        component: 'Supademo',
        message: blocker.message
      });
    }
  } else {
    for (const supademo of supademos) {
      items.push({
        code: 'supademo-missing',
        severity: 'blocker',
        component: 'Supademo',
        message: `no verified ISV correspondence for Supademo ${supademo.componentId}`,
        sourceLine: supademo.sourceLine
      });
    }
  }

  return {
    safeToPublish: !items.some((item) => item.severity === 'blocker'),
    items: dedupeItems(items)
  };
}

function dedupeItems(items: ZdocRoundTripItem[]): ZdocRoundTripItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
