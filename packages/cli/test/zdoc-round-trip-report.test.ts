import { describe, expect, it } from 'vitest';
import { buildZdocRoundTripReport } from '../src/zdoc/round-trip-report.js';
import type { ZdocComponentInventory } from '../src/zdoc/types.js';

describe('Zdoc round-trip report', () => {
  it('reports a Procedures move and transformed Admonition as safe', () => {
    const report = buildZdocRoundTripReport({
      inventory: inventory([
        { kind: 'admonition', title: 'Billing', calloutType: 'note', status: 'transformed', sourceLine: 1, sectionPath: [] },
        { kind: 'procedures', token: 'open', status: 'preserved', sourceLine: 5, sectionPath: ['Create'] },
        { kind: 'procedures', token: 'close', status: 'preserved', sourceLine: 9, sectionPath: ['Create'] }
      ]),
      procedures: {
        operations: [{
          kind: 'authoring-token-move',
          locator: { sectionPath: ['Create'], kind: 'authoring-token', ordinal: 0 },
          token: '<Procedures>',
          remoteBlockId: 'open',
          insertAfterBlockId: 'intro'
        }],
        blockers: []
      }
    });

    expect(report.safeToPublish).toBe(true);
    expect(report.items).toContainEqual(expect.objectContaining({
      code: 'procedures-move',
      severity: 'warning'
    }));
    expect(report.items).toContainEqual(expect.objectContaining({
      code: 'admonition-transform',
      severity: 'info'
    }));
  });

  it('blocks unknown components and unresolved Supademo resources', () => {
    const report = buildZdocRoundTripReport({
      inventory: inventory([
        { kind: 'supademo', componentId: 'demo', status: 'preserved', sourceLine: 3, sectionPath: ['Demo'] },
        { kind: 'unknown', componentName: 'Tabs', status: 'blocking', sourceLine: 8, sectionPath: ['Demo'] }
      ]),
      procedures: { operations: [], blockers: [] }
    });

    expect(report.safeToPublish).toBe(false);
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'supademo-missing', severity: 'blocker' }),
      expect.objectContaining({ code: 'component-unsupported', severity: 'blocker' })
    ]));
  });

  it('reports Procedures deletion with the affected remote block identity', () => {
    const report = buildZdocRoundTripReport({
      inventory: inventory([]),
      procedures: {
        operations: [{
          kind: 'authoring-token-delete',
          locator: { sectionPath: ['Create'], kind: 'authoring-token', ordinal: 0 },
          token: '<Procedures>',
          parentBlockId: 'page',
          remoteBlockId: 'open-token'
        }],
        blockers: []
      }
    });

    expect(report.items).toContainEqual(expect.objectContaining({
      code: 'procedures-delete',
      severity: 'warning',
      remoteBlockId: 'open-token'
    }));
  });
});

function inventory(components: ZdocComponentInventory['components']): ZdocComponentInventory {
  return { components, ignoredMetadata: [] };
}
