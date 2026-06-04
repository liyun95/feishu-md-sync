import type { MultisdkLanguage } from './language.js';
import type { MultisdkMilvusTarget } from './task.js';

export type MantaExec = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export type RunMantaValidationInput = {
  taskDir: string;
  language: MultisdkLanguage;
  command: string;
  milvusTarget: MultisdkMilvusTarget;
  exec: MantaExec;
};

export type RunMantaValidationResult = {
  jobId: string;
  logs: string;
};

export async function runMantaValidation(input: RunMantaValidationInput): Promise<RunMantaValidationResult> {
  const prompt = [
    `Run multi-SDK ${input.language} validation.`,
    `Task directory: ${input.taskDir}`,
    `Milvus target: ${renderMilvusTarget(input.milvusTarget)}`,
    `Validation command: ${input.command}`,
    'Start a real Milvus instance, run the verifier command, and make the logs show every example passed.'
  ].join('\n');

  const created = await input.exec('manta-client', ['-q', 'job', 'create', '-p', prompt, '-T', '1800']);
  const jobId = created.stdout.trim();
  if (!jobId) throw new Error('manta-client did not return a job id.');

  await input.exec('manta-client', ['-q', 'job', 'wait', jobId, '--timeout', '1800']);
  const logs = await input.exec('manta-client', ['job', 'logs', jobId]);
  return { jobId, logs: logs.stdout };
}

function renderMilvusTarget(target: MultisdkMilvusTarget): string {
  if (target.kind === 'released-version') return target.version;
  return `${target.version} from ${target.sourceRepo}@${target.sourceRef}`;
}
