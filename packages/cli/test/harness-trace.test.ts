import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendHarnessTraceEvent,
  readHarnessTraceEvents,
  redactTraceArguments
} from '../src/harness/trace.js';

const tempDirs: string[] = [];

describe('harness trace', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('appends trace events with relative artifact paths and hashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trace-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence/java.log'), 'PASS\n', 'utf8');

    const event = await appendHarnessTraceEvent({
      workflow: 'multisdk',
      taskDir: dir,
      tool: 'multisdk.verify',
      mode: 'record-evidence',
      status: 'passed',
      startedAt: '2026-05-26T00:00:00.000Z',
      endedAt: '2026-05-26T00:00:02.000Z',
      arguments: {
        language: 'java',
        appSecret: 'secret-value'
      },
      artifactPaths: [join(dir, 'evidence/java.log')],
      summary: 'Recorded java validation evidence.',
      eventId: 'event-1'
    });

    expect(event).toEqual(expect.objectContaining({
      kind: 'feishu-harness-trace-event',
      version: 1,
      eventId: 'event-1',
      workflow: 'multisdk',
      taskDir: dir,
      tool: 'multisdk.verify',
      mode: 'record-evidence',
      status: 'passed',
      durationMs: 2000,
      summary: 'Recorded java validation evidence.'
    }));
    expect(event.arguments).toEqual({
      language: 'java',
      appSecret: '[REDACTED]'
    });
    expect(event.artifacts).toEqual([
      {
        path: 'evidence/java.log',
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    ]);

    const events = await readHarnessTraceEvents(dir);
    expect(events).toEqual([event]);
  });

  it('redacts secret-like nested arguments', () => {
    expect(redactTraceArguments({
      plain: 'value',
      nested: {
        password: 'pw',
        accessToken: 'token',
        documentId: 'doc-id'
      }
    })).toEqual({
      plain: 'value',
      nested: {
        password: '[REDACTED]',
        accessToken: '[REDACTED]',
        documentId: 'doc-id'
      }
    });
  });

  it('returns an empty trace for legacy tasks with no trace file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trace-empty-'));
    tempDirs.push(dir);

    await expect(readHarnessTraceEvents(dir)).resolves.toEqual([]);
  });
});
