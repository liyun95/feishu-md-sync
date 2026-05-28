import { FeishuApiError } from './errors.js';

export type FeishuRetryOptions = {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function withFeishuRetry<T>(
  operation: () => Promise<T>,
  options: FeishuRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableFeishuError(error)) break;
      await sleep(250 * attempt);
    }
  }

  throw lastError;
}

function isRetryableFeishuError(error: unknown): boolean {
  return error instanceof FeishuApiError &&
    (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504);
}
