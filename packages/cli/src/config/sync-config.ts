import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parsePublishProfileName,
  type PublishProfileConfig,
  type PublishProfileName
} from '../profiles/publish-profile.js';

export type SyncConfig = {
  defaultProfile?: PublishProfileName;
  profiles: Record<string, PublishProfileConfig>;
};

export type LoadSyncConfigInput = {
  cwd: string;
};

export function resolvePublishProfile(input: {
  cliProfile?: string;
  config: SyncConfig;
}): PublishProfileName {
  if (input.cliProfile) return parsePublishProfileName(input.cliProfile, '--profile');
  return input.config.defaultProfile ?? 'none';
}

export async function loadSyncConfig(input: LoadSyncConfigInput): Promise<SyncConfig> {
  const path = join(input.cwd, 'feishu-md-sync.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('feishu-md-sync.config.json must contain a JSON object.');
  }

  const defaultProfile = typeof parsed.defaultProfile === 'string'
    ? parsePublishProfileName(parsed.defaultProfile, 'defaultProfile')
    : undefined;

  return {
    defaultProfile,
    profiles: parseProfiles(parsed.profiles)
  };
}

function parseProfiles(value: unknown): Record<string, PublishProfileConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('profiles must be a JSON object.');

  const profiles: Record<string, PublishProfileConfig> = {};
  for (const [name, rawProfile] of Object.entries(value)) {
    parsePublishProfileName(name, 'profile name');
    if (!isRecord(rawProfile)) throw new Error(`profiles.${name} must be a JSON object.`);
    profiles[name] = {
      includeTargets: parseStringArray(rawProfile.includeTargets, `profiles.${name}.includeTargets`),
      excludeTargets: parseStringArray(rawProfile.excludeTargets, `profiles.${name}.excludeTargets`),
      productNameMarkup: typeof rawProfile.productNameMarkup === 'boolean' ? rawProfile.productNameMarkup : undefined
    };
  }
  return profiles;
}

function parseStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
