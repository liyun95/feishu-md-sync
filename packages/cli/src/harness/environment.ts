import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthDoctorReport, CliEnvLoadReport } from '../cli/env.js';
import { buildAuthDoctorReport } from '../cli/env.js';
import { listValidationProfiles } from '../multisdk/validation-profile.js';

export type HarnessPathCheckInput = {
  name: string;
  path: string;
};

export type HarnessPathCheck = HarnessPathCheckInput & {
  exists: boolean;
  type: 'file' | 'directory' | 'other' | 'missing';
};

export type HarnessValidationProfileSummary = {
  id: string;
  language: string;
  title: string;
  containerImage?: string;
  commands: string[];
};

export type HarnessEnvironmentReport = {
  kind: 'feishu-harness-environment';
  version: 1;
  generatedAt: string;
  node: string;
  npm: string | null;
  cwd: string;
  cli: {
    name: string;
    version: string;
  };
  feishu: {
    host: string;
    appIdPresent: boolean;
    appSecretPresent: boolean;
  };
  envFiles: AuthDoctorReport['envFiles'];
  validationProfiles: HarnessValidationProfileSummary[];
  pathChecks: HarnessPathCheck[];
};

export type HarnessPackageInfo = {
  name: string;
  version: string;
};

export type HarnessEnvironmentInput = {
  envLoadReport: CliEnvLoadReport;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => string;
  nodeVersion?: string;
  npmVersion?: string | null;
  packageInfo?: HarnessPackageInfo;
  pathChecks?: HarnessPathCheckInput[];
};

export async function buildHarnessEnvironmentReport(
  input: HarnessEnvironmentInput
): Promise<HarnessEnvironmentReport> {
  const env = input.env ?? process.env;
  const auth = buildAuthDoctorReport(input.envLoadReport, env);
  const packageInfo = input.packageInfo ?? await readCliPackageInfo();
  return {
    kind: 'feishu-harness-environment',
    version: 1,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    node: input.nodeVersion ?? process.version,
    npm: input.npmVersion ?? npmVersionFromUserAgent(env.npm_config_user_agent),
    cwd: input.cwd ?? input.envLoadReport.cwd,
    cli: packageInfo,
    feishu: {
      host: auth.feishuHost,
      appIdPresent: auth.appId.present,
      appSecretPresent: auth.appSecret.present
    },
    envFiles: auth.envFiles,
    validationProfiles: listValidationProfiles().map((profile) => ({
      id: profile.id,
      language: profile.language,
      title: profile.title,
      containerImage: profile.containerImage,
      commands: profile.commands
    })),
    pathChecks: await Promise.all((input.pathChecks ?? []).map(checkHarnessPath))
  };
}

export async function writeHarnessEnvironment(
  taskDir: string,
  report: HarnessEnvironmentReport
): Promise<string> {
  await mkdir(taskDir, { recursive: true });
  const path = join(taskDir, 'environment.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

async function checkHarnessPath(input: HarnessPathCheckInput): Promise<HarnessPathCheck> {
  try {
    const info = await stat(input.path);
    return {
      ...input,
      exists: true,
      type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      ...input,
      exists: false,
      type: 'missing'
    };
  }
}

async function readCliPackageInfo(): Promise<HarnessPackageInfo> {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  ) as Partial<HarnessPackageInfo>;
  return {
    name: packageJson.name ?? 'feishu-md-sync',
    version: packageJson.version ?? '0.0.0'
  };
}

function npmVersionFromUserAgent(userAgent: string | undefined): string | null {
  const match = userAgent?.match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] ?? null;
}
