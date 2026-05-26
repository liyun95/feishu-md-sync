import type { CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';

export type MultisdkLanguage = Exclude<CanonicalCodeBlockLanguage, 'python'>;

export const MULTISDK_LANGUAGES: MultisdkLanguage[] = [
  'java',
  'javascript',
  'go',
  'restful'
];

export function normalizeMultisdkLanguage(value: string): MultisdkLanguage | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'java') return 'java';
  if (normalized === 'javascript' || normalized === 'node' || normalized === 'nodejs' || normalized === 'js') {
    return 'javascript';
  }
  if (normalized === 'go') return 'go';
  if (normalized === 'restful') return 'restful';
  return null;
}

export function parseMultisdkLanguage(value: string): MultisdkLanguage {
  const language = normalizeMultisdkLanguage(value);
  if (!language) {
    throw new Error(`Invalid --language ${value}. Expected java, javascript/node/nodejs/js, go, or restful.`);
  }
  return language;
}
