import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export type CliEnvLoadOptions = {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
};

export type CliEnvLoadReport = {
  cwd: string;
  explicitEnvFile?: string;
  attemptedFiles: string[];
  loadedFiles: string[];
};

export type AuthDoctorReport = {
  envFiles: Array<{
    path: string;
    loaded: boolean;
    explicit: boolean;
  }>;
  larkCli: {
    command: string;
    identity: 'auto' | 'bot' | 'user';
    identityEnv?: string;
    warning?: string;
  };
};

export function loadCliEnv(options: CliEnvLoadOptions = {}): CliEnvLoadReport {
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicitEnvFile = envFileFromArgv(argv, cwd);
  const attemptedFiles = candidateEnvFiles({
    cwd,
    explicitEnvFile,
    moduleUrl: options.moduleUrl
  });
  const loadedFiles: string[] = [];

  for (const file of attemptedFiles) {
    if (!existsSync(file)) {
      if (file === explicitEnvFile) {
        throw new Error(`--env-file does not exist: ${file}`);
      }
      continue;
    }
    const result = loadDotenv({
      path: file,
      processEnv: env as Record<string, string>,
      override: file === explicitEnvFile
    });
    if (result.error) throw result.error;
    loadedFiles.push(file);
  }

  return {
    cwd,
    explicitEnvFile,
    attemptedFiles,
    loadedFiles
  };
}

export function buildAuthDoctorReport(
  report: CliEnvLoadReport,
  env: NodeJS.ProcessEnv = process.env
): AuthDoctorReport {
  const identityEnv = env.FEISHU_MD_SYNC_LARK_AS;
  const identity = identityEnv === 'bot' || identityEnv === 'user' ? identityEnv : 'auto';
  return {
    envFiles: report.attemptedFiles.map((file) => ({
      path: file,
      loaded: report.loadedFiles.includes(file),
      explicit: file === report.explicitEnvFile
    })),
    larkCli: {
      command: 'lark-cli auth status',
      identity,
      identityEnv,
      warning: identityEnv && identity === 'auto'
        ? 'FEISHU_MD_SYNC_LARK_AS must be "bot" or "user"; falling back to lark-cli default identity.'
        : undefined
    }
  };
}

function candidateEnvFiles(input: {
  cwd: string;
  explicitEnvFile?: string;
  moduleUrl?: string;
}): string[] {
  const files: string[] = [];
  if (input.explicitEnvFile) files.push(input.explicitEnvFile);
  files.push(resolve(input.cwd, '.env'));

  for (const root of packageRootsFromModule(input.moduleUrl)) {
    files.push(join(root, '.env'));
  }

  return Array.from(new Set(files));
}

function envFileFromArgv(argv: string[], cwd: string): string | undefined {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const arg = argv[index];
    if (arg === '--env-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--env-file requires a path.');
      return resolveEnvPath(value, cwd);
    }
    if (arg.startsWith('--env-file=')) {
      return resolveEnvPath(arg.slice('--env-file='.length), cwd);
    }
  }
  return undefined;
}

function resolveEnvPath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function packageRootsFromModule(moduleUrl: string | undefined): string[] {
  if (!moduleUrl?.startsWith('file:')) return [];
  let current = dirname(fileURLToPath(moduleUrl));
  const roots: string[] = [];

  while (true) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      roots.push(current);
      if (isWorkspaceRoot(packagePath)) break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

function isWorkspaceRoot(packagePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) || Boolean(parsed.workspaces);
  } catch {
    return false;
  }
}
