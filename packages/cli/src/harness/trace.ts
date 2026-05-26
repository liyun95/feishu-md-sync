import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { HarnessWorkflow } from './tools.js';

export type HarnessTraceStatus = 'passed' | 'failed';

export type HarnessTraceArtifact = {
  path: string;
  sha256?: string;
};

export type HarnessTraceEvent = {
  kind: 'feishu-harness-trace-event';
  version: 1;
  eventId: string;
  workflow: HarnessWorkflow;
  taskDir: string;
  tool: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: HarnessTraceStatus;
  arguments: unknown;
  artifacts: HarnessTraceArtifact[];
  summary: string;
};

export type AppendHarnessTraceEventInput = {
  workflow: HarnessWorkflow;
  taskDir: string;
  tool: string;
  mode: string;
  startedAt: string;
  endedAt?: string;
  status: HarnessTraceStatus;
  arguments?: unknown;
  artifactPaths?: string[];
  summary: string;
  eventId?: string;
};

export async function appendHarnessTraceEvent(
  input: AppendHarnessTraceEventInput
): Promise<HarnessTraceEvent> {
  const event = await buildHarnessTraceEvent(input);
  const path = harnessTracePath(input.taskDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export async function readHarnessTraceEvents(taskDir: string): Promise<HarnessTraceEvent[]> {
  try {
    const content = await readFile(harnessTracePath(taskDir), 'utf8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HarnessTraceEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function harnessTracePath(taskDir: string): string {
  return join(taskDir, 'trace/events.jsonl');
}

export function redactTraceArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraceArguments);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSecretLikeKey(key) ? '[REDACTED]' : redactTraceArguments(child);
  }
  return output;
}

async function buildHarnessTraceEvent(input: AppendHarnessTraceEventInput): Promise<HarnessTraceEvent> {
  const endedAt = input.endedAt ?? new Date().toISOString();
  return {
    kind: 'feishu-harness-trace-event',
    version: 1,
    eventId: input.eventId ?? randomUUID(),
    workflow: input.workflow,
    taskDir: input.taskDir,
    tool: input.tool,
    mode: input.mode,
    startedAt: input.startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(input.startedAt)),
    status: input.status,
    arguments: redactTraceArguments(input.arguments ?? {}),
    artifacts: await Promise.all((input.artifactPaths ?? []).map((path) => traceArtifact(input.taskDir, path))),
    summary: input.summary
  };
}

async function traceArtifact(taskDir: string, path: string): Promise<HarnessTraceArtifact> {
  const absolutePath = isAbsolute(path) ? path : join(taskDir, path);
  return {
    path: relative(taskDir, absolutePath),
    sha256: await sha256File(absolutePath)
  };
}

async function sha256File(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'password' ||
    normalized === 'appsecret' ||
    normalized === 'app_secret' ||
    normalized === 'secret' ||
    normalized === 'accesstoken' ||
    normalized === 'access_token' ||
    normalized === 'refreshtoken' ||
    normalized === 'refresh_token';
}
