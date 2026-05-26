import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReferenceWebContentConfig } from './workflow-config.js';

export type WebContentCommand = {
  cwd: string;
  command: string;
  args: string[];
};

export type WebContentRepoCheck = {
  repo: string;
  configPath: string;
  scriptPath: string;
};

export type WebContentRunResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function validateWebContentRepo(options: { repo: string; config: string }): Promise<WebContentRepoCheck> {
  const repo = resolve(options.repo);
  const scriptPath = join(repo, 'scripts/lark-docs/index.js');
  const configPath = resolve(repo, options.config);

  await mustAccess(scriptPath, 'web-content lark-docs script');
  await mustAccess(configPath, 'web-content config');

  return { repo, configPath, scriptPath };
}

export function buildWebContentCommand(config: ReferenceWebContentConfig): WebContentCommand {
  const args = [
    'scripts/lark-docs/index.js',
    '--config',
    config.config,
    '--manual',
    config.manual
  ];

  if (config.mode === 'check') {
    args.push('--dry-run');
  } else {
    if (config.all) args.push('--all');
    if (config.doc) args.push('--doc', config.doc);
    if (config.recursive) args.push('--recursive');
    if (config.output) args.push('--output', config.output);
    if (typeof config.position === 'number') args.push('--position', String(config.position));
    if (config.skipImageDown) args.push('--skipImageDown');
  }

  return {
    cwd: resolve(config.repo),
    command: process.execPath,
    args
  };
}

export async function runWebContentCommand(config: ReferenceWebContentConfig): Promise<WebContentRunResult> {
  await validateWebContentRepo(config);
  return run(buildWebContentCommand(config));
}

async function run(command: WebContentCommand): Promise<WebContentRunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      resolveRun({
        command: [command.command, ...command.args].join(' '),
        cwd: command.cwd,
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}`
      });
    });
    child.on('close', (exitCode) => {
      resolveRun({
        command: [command.command, ...command.args].join(' '),
        cwd: command.cwd,
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

async function mustAccess(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing ${label}: ${path}`);
  }
}
