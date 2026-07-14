import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALLOUT_CONFIG,
  loadSyncConfig,
  resolveCalloutConfig,
  resolvePublishProfile
} from '../src/config/sync-config.js';

describe('sync config', () => {
  it('falls back to none when no config and no CLI profile exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));

    await expect(loadSyncConfig({ cwd: dir })).resolves.toEqual({
      defaultProfile: undefined,
      profiles: {}
    });
    expect(resolvePublishProfile({ cliProfile: undefined, config: { profiles: {} } })).toBe('none');
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
    expect(() => resolvePublishProfile({ cliProfile: 'cloud', config: { profiles: {} } })).toThrow(
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
});
