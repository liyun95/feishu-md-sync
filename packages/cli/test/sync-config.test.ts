import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALLOUT_CONFIG,
  loadSyncConfig,
  resolveCalloutConfig,
  resolveCodeBlockConfig,
  resolveDialect,
  resolveDialectConfig,
  resolvePublishProfile
} from '../src/config/sync-config.js';

describe('sync config', () => {
  it('falls back to none when no config and no CLI profile exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));

    await expect(loadSyncConfig({ cwd: dir })).resolves.toEqual({
      defaultProfile: undefined,
      profiles: {},
      dialects: {}
    });
    expect(resolvePublishProfile({
      cliProfile: undefined,
      config: { profiles: {}, dialects: {} }
    })).toBe('none');
  });

  it('loads defaultProfile from feishu-md-sync.config.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      defaultProfile: 'zilliz',
      profiles: {
        zilliz: { includeTargets: ['zilliz'], excludeTargets: ['milvus'] }
      }
    }), 'utf8');

    const config = await loadSyncConfig({ cwd: dir });

    expect(config.defaultProfile).toBe('zilliz');
    expect(resolvePublishProfile({ cliProfile: undefined, config })).toBe('zilliz');
    expect(resolvePublishProfile({ cliProfile: 'milvus', config })).toBe('milvus');
  });

  it('rejects unknown profile names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      defaultProfile: 'cloud'
    }), 'utf8');

    await expect(loadSyncConfig({ cwd: dir })).rejects.toThrow(
      'Invalid defaultProfile cloud. Expected zilliz, milvus, or none.'
    );
    expect(() => resolvePublishProfile({
      cliProfile: 'cloud',
      config: { profiles: {}, dialects: {} }
    })).toThrow(
      'Invalid --profile cloud. Expected zilliz, milvus, or none.'
    );
  });

  it('uses English Callout titles by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    const config = await loadSyncConfig({ cwd: dir });

    expect(resolveCalloutConfig(config)).toEqual(DEFAULT_CALLOUT_CONFIG);
  });

  it('loads workspace Callout title overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      callouts: { noteTitle: '说明', warningTitle: '警告' }
    }), 'utf8');

    const config = await loadSyncConfig({ cwd: dir });
    expect(resolveCalloutConfig(config)).toEqual({
      noteTitle: '说明',
      warningTitle: '警告'
    });
  });

  it('rejects non-string Callout titles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      callouts: { noteTitle: false }
    }), 'utf8');

    await expect(loadSyncConfig({ cwd: dir })).rejects.toThrow(
      'callouts.noteTitle must be a non-empty string.'
    );
  });

  it('loads Code block language aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      codeBlocks: {
        languageAliases: {
          curl: 'bash',
          conf: 'plaintext'
        }
      }
    }), 'utf8');

    const config = await loadSyncConfig({ cwd: dir });

    expect(resolveCodeBlockConfig(config)).toEqual({
      languageAliases: {
        curl: 'bash',
        conf: 'plaintext'
      }
    });
  });

  it('rejects malformed Code block aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      codeBlocks: { languageAliases: { curl: '' } }
    }), 'utf8');

    await expect(loadSyncConfig({ cwd: dir })).rejects.toThrow(
      'codeBlocks.languageAliases.curl must be a non-empty string.'
    );
  });

  it('loads a Docusaurus dialect and read-only Base resolver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-dialect-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      defaultDialect: 'docusaurus',
      dialects: {
        docusaurus: {
          publicSiteBaseUrl: 'https://docs.zilliz.com/docs',
          linkResolver: {
            type: 'lark-base',
            baseUrl: 'https://zilliverse.feishu.cn/base/base_token',
            keyField: 'Slug',
            urlField: 'Docs',
            placementTypeField: 'Placement Type',
            referenceField: 'Ref Target Doc',
            acceptedPlacementTypes: ['canonical', 'ref']
          }
        }
      }
    }), 'utf8');

    const config = await loadSyncConfig({ cwd: dir });

    expect(resolveDialect({ cliDialect: undefined, config })).toBe('docusaurus');
    expect(resolveDialect({ cliDialect: 'gfm', config })).toBe('gfm');
    expect(resolveDialectConfig(config, 'docusaurus')).toMatchObject({
      publicSiteBaseUrl: 'https://docs.zilliz.com/docs',
      linkResolver: { type: 'lark-base', keyField: 'Slug' }
    });
  });

  it('rejects unknown dialect names', () => {
    expect(() => resolveDialect({
      cliDialect: 'mdx',
      config: { profiles: {}, dialects: {} }
    })).toThrow('Invalid --dialect mdx. Expected gfm, docusaurus, or milvus-authoring.');
  });

  it('rejects resolver keys that imply write behavior', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-dialect-write-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      dialects: {
        docusaurus: {
          linkResolver: {
            type: 'lark-base',
            baseUrl: 'https://example.feishu.cn/base/base_token',
            keyField: 'Slug',
            urlField: 'Docs',
            placementTypeField: 'Placement Type',
            acceptedPlacementTypes: ['canonical'],
            writeBack: true
          }
        }
      }
    }), 'utf8');

    await expect(loadSyncConfig({ cwd: dir })).rejects.toThrow(
      'dialects.docusaurus.linkResolver.writeBack is not supported.'
    );
  });
});
