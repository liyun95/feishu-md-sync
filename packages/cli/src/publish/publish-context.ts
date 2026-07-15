import { readFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import { hashText } from '../receipts/publish-receipt.js';
import { sha256, stableStringify } from '../core/hash.js';
import { preprocessDialect } from '../dialects/preprocess.js';
import type {
  DialectDependency,
  DialectDiagnostic,
  DialectName
} from '../dialects/types.js';
import { createDocumentLinkResolver } from '../link-resolvers/create-resolver.js';
import type {
  DialectWorkspaceConfig,
  LinkResolutionSummary,
  ResolvedDocumentLink
} from '../link-resolvers/types.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import { applyPublishTransformForProfile } from './profile-transform.js';

export type PublishContext = {
  localSource: string;
  dialect: DialectName;
  dialectDraft: string;
  dialectDraftHash: string;
  publishDraft: string;
  publishDraftHash: string;
  dialectWarnings: DialectDiagnostic[];
  dialectBlockers: DialectDiagnostic[];
  dialectDependencies: DialectDependency[];
  resolvedLinks: ResolvedDocumentLink[];
  linkResolution: LinkResolutionSummary;
  linkResolutionFingerprint: string;
  transformWarnings: string[];
};

export async function buildPublishContext(input: {
  cwd: string;
  sourcePath: string;
  localSource?: string;
  dialect: DialectName;
  dialectConfig: DialectWorkspaceConfig;
  profile: PublishProfileName;
  adapter: FeishuAdapter;
}): Promise<PublishContext> {
  const localSource = input.localSource ?? await readFile(input.sourcePath, 'utf8');
  const resolver = await createDocumentLinkResolver({
    cwd: input.cwd,
    config: input.dialectConfig.linkResolver,
    adapter: input.adapter
  });
  const dialectResult = await preprocessDialect({
    cwd: input.cwd,
    sourcePath: input.sourcePath,
    markdown: localSource,
    dialect: input.dialect,
    config: input.dialectConfig,
    linkResolver: resolver.resolver
  });
  const transform = applyPublishTransformForProfile(dialectResult.markdown, input.profile);
  const resolvedLinks = [...dialectResult.resolvedLinks].sort((left, right) => {
    return stableStringify(left).localeCompare(stableStringify(right));
  });
  return {
    localSource,
    dialect: input.dialect,
    dialectDraft: dialectResult.markdown,
    dialectDraftHash: hashText(dialectResult.markdown),
    publishDraft: transform.markdown,
    publishDraftHash: hashText(transform.markdown),
    dialectWarnings: uniqueDiagnostics([
      ...resolver.warnings,
      ...dialectResult.warnings
    ]),
    dialectBlockers: uniqueDiagnostics(dialectResult.blockers),
    dialectDependencies: [...resolver.dependencies, ...dialectResult.dependencies],
    resolvedLinks,
    linkResolution: dialectResult.linkResolution,
    linkResolutionFingerprint: sha256(stableStringify(resolvedLinks.map((link) => ({
      originalUrl: link.originalUrl,
      slug: link.slug,
      resolvedUrl: link.resolvedUrl
    })))),
    transformWarnings: transform.warnings
  };
}

function uniqueDiagnostics(diagnostics: DialectDiagnostic[]): DialectDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = stableStringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
