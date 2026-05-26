import { spawn } from 'node:child_process';

export type ReferencePrBodyInput = {
  sdk: string;
  versionRange?: string;
  feishuReportPath?: string;
  webContentSummary?: string;
  risks?: string[];
};

export type ReferencePrCommandInput = {
  base: string;
  branch: string;
  title: string;
  bodyFile: string;
};

export type ReferencePrRunResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function buildReferencePrBody(input: ReferencePrBodyInput): string {
  const lines = [
    '## Summary',
    '',
    `- SDK: ${input.sdk}`,
    `- Version range: ${input.versionRange ?? 'not specified'}`,
    `- Feishu report: ${input.feishuReportPath ?? 'not generated'}`,
    '',
    '## web-content export',
    '',
    input.webContentSummary?.trim() || 'No web-content output captured.',
    '',
    '## Risks',
    '',
    ...(input.risks?.length ? input.risks.map((risk) => `- ${risk}`) : ['- No known residual risks.'])
  ];
  return `${lines.join('\n')}\n`;
}

export function buildReferencePrCommand(input: ReferencePrCommandInput): string[] {
  return [
    'gh',
    'pr',
    'create',
    '--base',
    input.base,
    '--head',
    input.branch,
    '--title',
    input.title,
    '--body-file',
    input.bodyFile
  ];
}

export function formatShellCommand(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

export async function runReferencePrCommand(input: ReferencePrCommandInput, cwd: string): Promise<ReferencePrRunResult> {
  const args = buildReferencePrCommand(input);
  const command = formatShellCommand(args);
  return new Promise((resolveRun) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      resolveRun({
        command,
        cwd,
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}`
      });
    });
    child.on('close', (exitCode) => {
      resolveRun({
        command,
        cwd,
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}
