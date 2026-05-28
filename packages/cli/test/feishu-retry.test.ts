import { describe, expect, it, vi } from 'vitest';
import { FeishuApiError } from '../src/services/feishu/errors.js';
import { withFeishuRetry } from '../src/services/feishu/retry.js';

describe('Feishu retry policy', () => {
  it('retries rate-limited requests and then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new FeishuApiError('rate limited', { code: 99991400, status: 429 }))
      .mockResolvedValueOnce('ok');

    await expect(withFeishuRetry(fn, { sleep: async () => undefined })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry validation errors', async () => {
    const fn = vi.fn().mockRejectedValue(new FeishuApiError('bad request', { code: 230001, status: 400 }));
    await expect(withFeishuRetry(fn, { sleep: async () => undefined })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
