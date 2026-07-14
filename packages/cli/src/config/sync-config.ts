import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import {
  parsePublishProfileName,
  type PublishProfileConfig,
  type PublishProfileName
} from '../profiles/publish-profile.js';

export type SyncConfig = {
  defaultProfile?: PublishProfileName;
  profiles: Record<string, PublishProfileConfig>;
  callouts?: Partial<CalloutConfig>;
  codeBlocks?: Partial<CodeBlockConfig>;
};

export type CalloutConfig = {
  noteTitle: string;
  warningTitle: string;
};

export const DEFAULT_CALLOUT_CONFIG: CalloutConfig = {
  noteTitle: 'Notes',
  warningTitle: 'Warning'
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

export function resolveCalloutConfig(config: SyncConfig): CalloutConfig {
  return {
    noteTitle: config.callouts?.noteTitle ?? DEFAULT_CALLOUT_CONFIG.noteTitle,
    warningTitle: config.callouts?.warningTitle ?? DEFAULT_CALLOUT_CONFIG.warningTitle
  };
}

export function resolveCodeBlockConfig(config: SyncConfig): CodeBlockConfig {
  return {
    languageAliases: config.codeBlocks?.languageAliases ?? DEFAULT_CODE_BLOCK_CONFIG.languageAliases
  };
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
    profiles: parseProfiles(parsed.profiles),
    callouts: parseCallouts(parsed.callouts),
    codeBlocks: parseCodeBlocks(parsed.codeBlocks)
  };
}

function parseCodeBlocks(value: unknown): Partial<CodeBlockConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('codeBlocks must be a JSON object.');
  if (value.languageAliases === undefined) return {};
  if (!isRecord(value.languageAliases)) {
    throw new Error('codeBlocks.languageAliases must be a JSON object.');
  }
  const languageAliases: Record<string, string> = {};
  for (const [source, target] of Object.entries(value.languageAliases)) {
    if (source.trim() === '') {
      throw new Error('codeBlocks.languageAliases keys must be non-empty strings.');
    }
    languageAliases[source.toLowerCase()] = parseOptionalNonEmptyString(
      target,
      `codeBlocks.languageAliases.${source}`
    )!;
  }
  return { languageAliases };
}

function parseCallouts(value: unknown): Partial<CalloutConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('callouts must be a JSON object.');
  return {
    noteTitle: parseOptionalNonEmptyString(value.noteTitle, 'callouts.noteTitle'),
    warningTitle: parseOptionalNonEmptyString(value.warningTitle, 'callouts.warningTitle')
  };
}

function parseOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
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
