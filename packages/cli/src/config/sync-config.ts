import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import {
  parsePublishProfileName,
  type PublishProfileConfig,
  type PublishProfileName
} from '../profiles/publish-profile.js';
import {
  DIALECT_NAMES,
  type DialectName
} from '../dialects/types.js';
import type {
  DialectWorkspaceConfig,
  LarkBaseLinkResolverConfig
} from '../link-resolvers/types.js';

export type SyncConfig = {
  defaultProfile?: PublishProfileName;
  defaultDialect?: DialectName;
  profiles: Record<string, PublishProfileConfig>;
  dialects: Partial<Record<DialectName, DialectWorkspaceConfig>>;
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

export function resolveDialect(input: {
  cliDialect?: string;
  config: SyncConfig;
}): DialectName {
  if (input.cliDialect) return parseDialectName(input.cliDialect, '--dialect');
  return input.config.defaultDialect ?? 'gfm';
}

export function resolveDialectConfig(
  config: SyncConfig,
  dialect: DialectName
): DialectWorkspaceConfig {
  return config.dialects[dialect] ?? {};
}

export function parseDialectName(value: string, label: string): DialectName {
  if ((DIALECT_NAMES as readonly string[]).includes(value)) return value as DialectName;
  throw new Error(`Invalid ${label} ${value}. Expected gfm, zdoc-authoring, or milvus-authoring.`);
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
  const configuredPath = process.env.FEISHU_MD_SYNC_CONFIG?.trim();
  const path = configuredPath
    ? resolvePath(input.cwd, configuredPath)
    : join(input.cwd, 'feishu-md-sync.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {}, dialects: {} };
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('feishu-md-sync.config.json must contain a JSON object.');
  }

  const defaultProfile = typeof parsed.defaultProfile === 'string'
    ? parsePublishProfileName(parsed.defaultProfile, 'defaultProfile')
    : undefined;
  const defaultDialect = typeof parsed.defaultDialect === 'string'
    ? parseDialectName(parsed.defaultDialect, 'defaultDialect')
    : undefined;

  return {
    defaultProfile,
    defaultDialect,
    profiles: parseProfiles(parsed.profiles),
    dialects: parseDialects(parsed.dialects),
    callouts: parseCallouts(parsed.callouts),
    codeBlocks: parseCodeBlocks(parsed.codeBlocks)
  };
}

function parseDialects(value: unknown): Partial<Record<DialectName, DialectWorkspaceConfig>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('dialects must be a JSON object.');

  const dialects: Partial<Record<DialectName, DialectWorkspaceConfig>> = {};
  for (const [name, rawDialect] of Object.entries(value)) {
    const dialect = parseDialectName(name, 'dialect name');
    if (!isRecord(rawDialect)) throw new Error(`dialects.${name} must be a JSON object.`);
    assertOnlyKeys(rawDialect, ['sourceRoot', 'publicSiteBaseUrl', 'linkResolver'], `dialects.${name}`);
    dialects[dialect] = {
      sourceRoot: parseOptionalNonEmptyString(rawDialect.sourceRoot, `dialects.${name}.sourceRoot`),
      publicSiteBaseUrl: parseOptionalNonEmptyString(
        rawDialect.publicSiteBaseUrl,
        `dialects.${name}.publicSiteBaseUrl`
      ),
      linkResolver: parseLinkResolver(rawDialect.linkResolver, `dialects.${name}.linkResolver`)
    };
  }
  return dialects;
}

function parseLinkResolver(
  value: unknown,
  label: string
): LarkBaseLinkResolverConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  assertOnlyKeys(value, [
    'type',
    'baseUrl',
    'keyField',
    'urlField',
    'placementTypeField',
    'referenceField',
    'acceptedPlacementTypes',
    'slugAliases'
  ], label);
  if (value.type !== 'lark-base') {
    throw new Error(`${label}.type must be lark-base.`);
  }
  const acceptedPlacementTypes = parseStringArray(
    value.acceptedPlacementTypes,
    `${label}.acceptedPlacementTypes`
  );
  if (!acceptedPlacementTypes || acceptedPlacementTypes.length === 0 ||
    acceptedPlacementTypes.some((item) => item.trim() === '')) {
    throw new Error(`${label}.acceptedPlacementTypes must be a non-empty array of non-empty strings.`);
  }
  return {
    type: 'lark-base',
    baseUrl: parseRequiredNonEmptyString(value.baseUrl, `${label}.baseUrl`),
    keyField: parseRequiredNonEmptyString(value.keyField, `${label}.keyField`),
    urlField: parseRequiredNonEmptyString(value.urlField, `${label}.urlField`),
    placementTypeField: parseRequiredNonEmptyString(
      value.placementTypeField,
      `${label}.placementTypeField`
    ),
    referenceField: parseOptionalNonEmptyString(value.referenceField, `${label}.referenceField`),
    acceptedPlacementTypes,
    slugAliases: parseStringRecord(value.slugAliases, `${label}.slugAliases`)
  };
}

function parseStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const result: Record<string, string> = {};
  for (const [source, target] of Object.entries(value)) {
    if (source.trim() === '') throw new Error(`${label} keys must be non-empty strings.`);
    result[source] = parseRequiredNonEmptyString(target, `${label}.${source}`);
  }
  return result;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label}.${key} is not supported.`);
  }
}

function parseRequiredNonEmptyString(value: unknown, label: string): string {
  const parsed = parseOptionalNonEmptyString(value, label);
  if (parsed === undefined) throw new Error(`${label} must be a non-empty string.`);
  return parsed;
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
