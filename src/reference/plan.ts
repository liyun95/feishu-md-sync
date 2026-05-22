import type { ReferenceAction, ReferenceManifest } from './manifest.js';

export type ReferenceImpactMatrix = {
  kind: 'sdk-reference-impact-matrix';
  sdk: string;
  versionRange?: string;
  targets?: ReferenceManifest['targets'];
  items: Array<{
    id: string;
    action: 'CREATE' | 'UPDATE' | 'DEPRECATE' | 'NO ACTION';
    title: string;
    markdownFile?: string;
    documentId?: string;
    recordId?: string;
    evidence?: string;
  }>;
};

export function planReferenceManifestFromImpact(impact: ReferenceImpactMatrix): ReferenceManifest {
  const actions: ReferenceAction[] = [];

  for (const item of impact.items) {
    if (item.action === 'NO ACTION') continue;
    const tracker = {
      tableName: impact.targets?.releaseAuditTableName,
      fields: {
        '文档/接口': item.title,
        '类型': item.action,
        '验证证据': item.evidence
      }
    };

    if (item.action === 'CREATE') {
      actions.push({
        id: item.id,
        action: 'createDoc',
        title: item.title,
        folderToken: impact.targets?.driveRootFolderToken,
        markdownFile: item.markdownFile,
        tracker
      });
      continue;
    }

    if (item.action === 'UPDATE') {
      actions.push({
        id: item.id,
        action: 'patchDoc',
        documentId: item.documentId,
        markdownFile: item.markdownFile,
        recordId: item.recordId,
        tracker
      });
      continue;
    }

    actions.push({
      id: item.id,
      action: 'updateRecord',
      recordId: item.recordId,
      fields: { Progress: 'Deprecated' },
      tracker
    });
  }

  return {
    kind: 'sdk-reference-publish-manifest',
    sdk: impact.sdk,
    versionRange: impact.versionRange,
    targets: impact.targets,
    actions
  };
}
