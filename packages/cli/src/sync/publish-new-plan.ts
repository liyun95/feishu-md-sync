import path from 'node:path';
import { parseFeishuTarget } from '../core/doc-id.js';

export type PublishTitleSource = 'option' | 'first H1' | 'file basename';

export type PublishNewDestination =
  | {
      kind: 'app-owned';
      source: string;
    }
  | {
      kind: 'folder';
      folderToken: string;
      source: string;
    }
  | {
      kind: 'wiki';
      folderToken: string;
      folderSource: string;
      spaceId: string;
      spaceSource: string;
      parentNodeToken: string;
      parentSource: string;
    };

export type PublishDuplicateCandidate = {
  title: string;
  url?: string;
  token?: string;
};

export type PublishNewPlan = {
  intent: 'publish local Markdown to a new Feishu document';
  sourcePath: string;
  title: string;
  titleSource: PublishTitleSource;
  destination: PublishNewDestination;
  duplicateCandidates: PublishDuplicateCandidate[];
  creationStrategy: 'block-pipeline';
  creates: {
    documents: 1;
    blocks: number;
    wikiMove: boolean;
  };
  receiptPath: string;
};

export type BuildPublishNewPlanInput = {
  sourcePath: string;
  markdown: string;
  blockCount: number;
  receiptPath?: string;
  duplicateCandidates?: PublishDuplicateCandidate[];
  options: {
    title?: string;
    folderToken?: string;
    appOwned?: boolean;
    wikiSpaceId?: string;
    wikiSpaceIdSource?: string;
    wikiParent?: string;
  };
  env: NodeJS.ProcessEnv;
};

export type ResolvePublishDestinationInput = Pick<BuildPublishNewPlanInput, 'sourcePath' | 'options' | 'env'>;

export class PublishNewUserError extends Error {
  constructor(
    message: string,
    readonly code: 'missing-destination' | 'missing-wiki-space-id' | 'missing-wiki-staging-folder' | 'duplicate-title'
  ) {
    super(message);
    this.name = 'PublishNewUserError';
  }
}

export function buildPublishNewPlan(input: BuildPublishNewPlanInput): PublishNewPlan {
  const title = resolvePublishTitle({
    sourcePath: input.sourcePath,
    markdown: input.markdown,
    title: input.options.title
  });
  const destination = resolvePublishDestination(input);

  return {
    intent: 'publish local Markdown to a new Feishu document',
    sourcePath: input.sourcePath,
    title: title.title,
    titleSource: title.titleSource,
    destination,
    duplicateCandidates: input.duplicateCandidates ?? [],
    creationStrategy: 'block-pipeline',
    creates: {
      documents: 1,
      blocks: input.blockCount,
      wikiMove: destination.kind === 'wiki'
    },
    receiptPath: input.receiptPath ?? ''
  };
}

export function resolvePublishTitle(input: {
  sourcePath: string;
  markdown: string;
  title?: string;
}): { title: string; titleSource: PublishTitleSource } {
  const explicit = clean(input.title);
  if (explicit) return { title: explicit, titleSource: 'option' };

  const firstH1 = input.markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
    .find((title) => title);
  if (firstH1) return { title: firstH1, titleSource: 'first H1' };

  return {
    title: path.basename(input.sourcePath, path.extname(input.sourcePath)) || 'Untitled',
    titleSource: 'file basename'
  };
}

export function resolvePublishDestination(input: ResolvePublishDestinationInput): PublishNewDestination {
  const explicitWikiParent = clean(input.options.wikiParent);
  const envWikiParent = clean(input.env.FEISHU_PUBLISH_PARENT_NODE_TOKEN);
  const wikiParent = explicitWikiParent ?? envWikiParent;
  const wikiParentSource = explicitWikiParent ? '--wiki-parent' : 'FEISHU_PUBLISH_PARENT_NODE_TOKEN';
  const explicitSpaceId = clean(input.options.wikiSpaceId);
  const envSpaceId = clean(input.env.FEISHU_PUBLISH_SPACE_ID);
  const spaceId = explicitSpaceId ?? envSpaceId;
  const spaceSource = input.options.wikiSpaceIdSource ?? (explicitSpaceId ? '--wiki-space-id' : 'FEISHU_PUBLISH_SPACE_ID');
  const explicitFolderToken = clean(input.options.folderToken);
  const envFolderToken = clean(input.env.FEISHU_PUBLISH_FOLDER_TOKEN);
  const folderToken = explicitFolderToken ?? envFolderToken;
  const folderSource = explicitFolderToken ? '--folder-token' : 'FEISHU_PUBLISH_FOLDER_TOKEN';
  const explicitAppOwned = input.options.appOwned === true;
  const envAppOwned = clean(input.env.FEISHU_PUBLISH_APP_OWNED)?.toLowerCase() === 'true';
  const appOwned = explicitAppOwned || envAppOwned;

  if (wikiParent && !spaceId) {
    throw new PublishNewUserError([
      'Cannot resolve the wiki destination because --wiki-parent was provided without --wiki-space-id and FEISHU_PUBLISH_SPACE_ID is not set.',
      '',
      'Nothing was created.',
      '',
      'Retry with:',
      `md2feishu publish-new ${input.sourcePath} --wiki-space-id <space-id> --wiki-parent <node-token>`
    ].join('\n'), 'missing-wiki-space-id');
  }

  if (wikiParent && !folderToken) {
    throw new PublishNewUserError([
      'Cannot publish to wiki yet because V1 needs a staging Drive folder before moving the docx into wiki.',
      '',
      'Nothing was created.',
      '',
      'Retry with:',
      `md2feishu publish-new ${input.sourcePath} --wiki-space-id <space-id> --wiki-parent <node-token> --folder-token <staging-folder-token>`
    ].join('\n'), 'missing-wiki-staging-folder');
  }

  if (wikiParent && spaceId && folderToken) {
    return {
      kind: 'wiki',
      folderToken,
      folderSource,
      spaceId,
      spaceSource,
      parentNodeToken: normalizeWikiParent(wikiParent),
      parentSource: wikiParentSource
    };
  }

  if (appOwned) {
    return {
      kind: 'app-owned',
      source: explicitAppOwned ? '--app-owned' : 'FEISHU_PUBLISH_APP_OWNED'
    };
  }

  if (folderToken) {
    return {
      kind: 'folder',
      folderToken,
      source: folderSource
    };
  }

  throw new PublishNewUserError([
    'Cannot publish a new Feishu document because no destination was configured.',
    '',
    'Nothing was created.',
    '',
    'Choose one:',
    `- publish as an app-owned docx now: md2feishu publish-new ${input.sourcePath} --app-owned`,
    '- publish to the configured team wiki: set FEISHU_PUBLISH_SPACE_ID, FEISHU_PUBLISH_PARENT_NODE_TOKEN, and FEISHU_PUBLISH_FOLDER_TOKEN',
    `- publish to a Drive folder now: md2feishu publish-new ${input.sourcePath} --folder-token <folder-token>`,
    `- publish to a wiki parent now: md2feishu publish-new ${input.sourcePath} --wiki-space-id <space-id> --wiki-parent <node-token> --folder-token <staging-folder-token>`
  ].join('\n'), 'missing-destination');
}

export function duplicateTitleError(
  sourcePath: string,
  title: string,
  candidates: PublishDuplicateCandidate[]
): PublishNewUserError {
  const firstUrl = candidates.find((candidate) => candidate.url)?.url ?? '<existing-feishu-url>';
  return new PublishNewUserError([
    `A document named "${title}" already exists in the destination.`,
    '',
    'Nothing was created.',
    '',
    'Candidates:',
    ...candidates.map((candidate) => `- ${candidate.title}: ${candidate.url ?? candidate.token ?? '<unknown-url>'}`),
    '',
    'Use the existing document:',
    `md2feishu push ${sourcePath} '${firstUrl}'`,
    '',
    'Or intentionally create a separate new document:',
    `md2feishu publish-new ${sourcePath} --title "${title}" --allow-duplicate-title --write`
  ].join('\n'), 'duplicate-title');
}

function normalizeWikiParent(value: string): string {
  if (!value.startsWith('http://') && !value.startsWith('https://')) return value;
  const target = parseFeishuTarget(value);
  if (target.kind !== 'wiki') {
    throw new Error(`--wiki-parent must be a wiki node token or wiki URL, got ${value}`);
  }
  return target.token;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
