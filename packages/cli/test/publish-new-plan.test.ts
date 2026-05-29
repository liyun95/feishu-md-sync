import { describe, expect, it } from 'vitest';
import {
  PublishNewUserError,
  buildPublishNewPlan,
  resolvePublishDestination,
  resolvePublishTitle
} from '../src/sync/publish-new-plan.js';

describe('publish-new plan', () => {
  it('resolves title from explicit title, first H1, then filename', () => {
    expect(resolvePublishTitle({
      sourcePath: '/tmp/local.md',
      markdown: '# Remote Title\n\nBody',
      title: 'Explicit Title'
    })).toEqual({ title: 'Explicit Title', titleSource: 'option' });

    expect(resolvePublishTitle({
      sourcePath: '/tmp/local.md',
      markdown: '# Remote Title\n\nBody'
    })).toEqual({ title: 'Remote Title', titleSource: 'first H1' });

    expect(resolvePublishTitle({
      sourcePath: '/tmp/my-doc.md',
      markdown: 'Body only'
    })).toEqual({ title: 'my-doc', titleSource: 'file basename' });
  });

  it('builds a wiki destination plan from explicit options', () => {
    const plan = buildPublishNewPlan({
      sourcePath: '/tmp/doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {
        title: 'Doc',
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParent: 'parent-node'
      },
      env: {}
    });

    expect(plan).toMatchObject({
      title: 'Doc',
      titleSource: 'option',
      creationStrategy: 'block-pipeline',
      destination: {
        kind: 'wiki',
        folderToken: 'folder-token',
        spaceId: 'space-id',
        parentNodeToken: 'parent-node'
      },
      creates: {
        documents: 1,
        blocks: 2,
        wikiMove: true
      }
    });
  });

  it('builds a folder destination plan from env fallback', () => {
    const plan = buildPublishNewPlan({
      sourcePath: '/tmp/doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {},
      env: {
        FEISHU_PUBLISH_FOLDER_TOKEN: 'folder-token'
      }
    });

    expect(plan.destination).toEqual({
      kind: 'folder',
      folderToken: 'folder-token',
      source: 'FEISHU_PUBLISH_FOLDER_TOKEN'
    });
  });

  it('builds an app-owned destination plan only when explicitly requested', () => {
    const plan = buildPublishNewPlan({
      sourcePath: '/tmp/doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {
        appOwned: true
      },
      env: {}
    });

    expect(plan.destination).toEqual({
      kind: 'app-owned',
      source: '--app-owned'
    });
    expect(plan.creates.wikiMove).toBe(false);
  });

  it('fails with guidance when no destination is configured', () => {
    expect(() => buildPublishNewPlan({
      sourcePath: './doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {},
      env: {}
    })).toThrow(PublishNewUserError);

    try {
      buildPublishNewPlan({
        sourcePath: './doc.md',
        markdown: '# Doc\n\nBody',
        blockCount: 2,
        options: {},
        env: {}
      });
    } catch (error) {
      expect((error as Error).message).toContain('Cannot publish a new Feishu document because no destination was configured.');
      expect((error as Error).message).toContain('Nothing was created.');
      expect((error as Error).message).toContain('md2feishu publish-new ./doc.md --folder-token <folder-token>');
    }
  });

  it('fails with guidance when wiki parent lacks a space id', () => {
    expect(() => resolvePublishDestination({
      sourcePath: './doc.md',
      options: { wikiParent: 'parent-node', folderToken: 'folder-token' },
      env: {}
    })).toThrow(/--wiki-parent was provided without --wiki-space-id/);
  });

  it('fails with guidance when wiki publish lacks the staging folder', () => {
    expect(() => resolvePublishDestination({
      sourcePath: './doc.md',
      options: { wikiParent: 'parent-node', wikiSpaceId: 'space-id' },
      env: {}
    })).toThrow(/V1 needs a staging Drive folder/);
  });
});
