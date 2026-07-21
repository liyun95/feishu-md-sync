import { describe, expect, it } from 'vitest';
import {
  disposableCleanupRequest,
  larkCliArgsWithIdentity,
  resolveDisposableLiveIdentities,
} from './support/live-feishu-cleanup.js';

describe('disposable live Feishu cleanup contract', () => {
  it('uses the explicit cleanup identity with exact returned-doc deletion argv', () => {
    const identities = resolveDisposableLiveIdentities({
      FEISHU_MD_SYNC_LARK_AS: 'user',
      FEISHU_MD_SYNC_ENGINE_CLEANUP_AS: 'bot',
    });

    expect(identities).toEqual({ writeIdentity: 'user', cleanupIdentity: 'bot' });
    expect(disposableCleanupRequest('docx-returned-id', identities.cleanupIdentity)).toEqual({
      identity: 'bot',
      args: [
        'drive',
        '+delete',
        '--file-token',
        'docx-returned-id',
        '--type',
        'docx',
        '--format',
        'json',
        '--yes',
      ],
    });
    expect(larkCliArgsWithIdentity(
      disposableCleanupRequest('docx-returned-id', identities.cleanupIdentity).args,
      identities.cleanupIdentity,
    )).toEqual([
      'drive', '+delete', '--file-token', 'docx-returned-id', '--type', 'docx',
      '--format', 'json', '--yes', '--as', 'bot',
    ]);
  });

  it('defaults cleanup to a valid explicit write identity', () => {
    expect(resolveDisposableLiveIdentities({ FEISHU_MD_SYNC_LARK_AS: 'bot' })).toEqual({
      writeIdentity: 'bot',
      cleanupIdentity: 'bot',
    });
  });

  it.each([
    [{}, 'FEISHU_MD_SYNC_LARK_AS must be explicitly set to user or bot'],
    [{ FEISHU_MD_SYNC_LARK_AS: 'auto' }, 'FEISHU_MD_SYNC_LARK_AS must be explicitly set to user or bot'],
    [
      { FEISHU_MD_SYNC_LARK_AS: 'user', FEISHU_MD_SYNC_ENGINE_CLEANUP_AS: 'owner' },
      'FEISHU_MD_SYNC_ENGINE_CLEANUP_AS must be user or bot',
    ],
  ])('rejects invalid identity configuration before a live create: %j', (env, message) => {
    expect(() => resolveDisposableLiveIdentities(env)).toThrow(message);
  });

  it('rejects an empty returned document ID instead of broadening cleanup', () => {
    expect(() => disposableCleanupRequest('', 'bot')).toThrow(
      'cleanup requires the exact returned document ID',
    );
  });
});
