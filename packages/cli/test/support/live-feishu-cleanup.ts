export type ExplicitLiveIdentity = 'user' | 'bot';

export function resolveDisposableLiveIdentities(env: Record<string, string | undefined>): {
  writeIdentity: ExplicitLiveIdentity;
  cleanupIdentity: ExplicitLiveIdentity;
} {
  const writeIdentity = explicitIdentity(
    env.FEISHU_MD_SYNC_LARK_AS,
    'FEISHU_MD_SYNC_LARK_AS must be explicitly set to user or bot',
  );
  const cleanupValue = env.FEISHU_MD_SYNC_ENGINE_CLEANUP_AS;
  const cleanupIdentity = cleanupValue === undefined || cleanupValue === ''
    ? writeIdentity
    : explicitIdentity(cleanupValue, 'FEISHU_MD_SYNC_ENGINE_CLEANUP_AS must be user or bot');
  return { writeIdentity, cleanupIdentity };
}

export function disposableCleanupRequest(
  documentId: string,
  identity: ExplicitLiveIdentity,
): { identity: ExplicitLiveIdentity; args: string[] } {
  if (!documentId.trim()) throw new Error('cleanup requires the exact returned document ID');
  return {
    identity,
    args: [
      'drive',
      '+delete',
      '--file-token',
      documentId,
      '--type',
      'docx',
      '--format',
      'json',
      '--yes',
    ],
  };
}

export function larkCliArgsWithIdentity(
  args: string[],
  identity: ExplicitLiveIdentity,
): string[] {
  return [...args, '--as', identity];
}

function explicitIdentity(value: string | undefined, message: string): ExplicitLiveIdentity {
  if (value === 'user' || value === 'bot') return value;
  throw new Error(message);
}
