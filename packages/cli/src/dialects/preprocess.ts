import type { DialectWorkspaceConfig, DocumentLinkResolver } from '../link-resolvers/types.js';
import { preprocessDocusaurus } from './docusaurus.js';
import { preprocessGfm } from './gfm.js';
import { preprocessMilvusAuthoring } from './milvus-authoring.js';
import type { DialectName, DialectResult } from './types.js';

export async function preprocessDialect(input: {
  cwd: string;
  sourcePath: string;
  markdown: string;
  dialect: DialectName;
  config: DialectWorkspaceConfig;
  linkResolver?: DocumentLinkResolver;
}): Promise<DialectResult> {
  if (input.dialect === 'gfm') {
    return preprocessGfm({ sourcePath: input.sourcePath, markdown: input.markdown });
  }
  if (input.dialect === 'docusaurus') {
    return preprocessDocusaurus({
      sourcePath: input.sourcePath,
      markdown: input.markdown,
      config: input.config,
      linkResolver: input.linkResolver
    });
  }
  if (input.dialect === 'milvus-authoring') {
    return preprocessMilvusAuthoring({
      cwd: input.cwd,
      sourcePath: input.sourcePath,
      markdown: input.markdown,
      config: input.config,
      linkResolver: input.linkResolver
    });
  }
  return {
    dialect: input.dialect,
    markdown: input.markdown,
    metadata: {},
    warnings: [],
    blockers: [{
      code: 'unsupported-mdx-component',
      severity: 'blocker',
      message: `Built-in dialect ${input.dialect} is not enabled yet.`,
      location: { file: input.sourcePath, line: 1, column: 1 }
    }],
    dependencies: [],
    resolvedLinks: [],
    linkResolution: {
      resolvedToFeishu: 0,
      resolvedFromFreshCache: 0,
      resolvedFromStaleCache: 0,
      resolvedToPublicSite: 0,
      unresolved: 0
    }
  };
}
