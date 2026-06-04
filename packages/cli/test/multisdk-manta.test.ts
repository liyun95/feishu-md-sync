import { describe, expect, it, vi } from 'vitest';
import { runMantaValidation } from '../src/multisdk/manta.js';

describe('multisdk manta validation', () => {
  it('creates a job, waits for completion, and records logs', async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('create')) return { stdout: 'job-123\n', stderr: '' };
      if (args.includes('wait')) return { stdout: '', stderr: '' };
      if (args.includes('logs')) return { stdout: 'PASS live Milvus validation\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runMantaValidation({
      taskDir: 'runs/doc-java',
      language: 'java',
      command: 'mvn test',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      exec
    });

    expect(result.jobId).toBe('job-123');
    expect(result.logs).toContain('PASS live Milvus validation');
    expect(exec.mock.calls.map((call) => call[1].slice(0, 3))).toEqual([
      ['-q', 'job', 'create'],
      ['-q', 'job', 'wait'],
      ['job', 'logs', 'job-123']
    ]);
  });
});
