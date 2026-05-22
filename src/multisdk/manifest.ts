import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeBlockManifest } from '../sync/code-block-plan.js';
import type { MultisdkLanguage } from './language.js';

export function filterManifestByLanguage(
  manifest: CodeBlockManifest,
  language: MultisdkLanguage
): CodeBlockManifest {
  return {
    ...manifest,
    items: manifest.items.filter((item) => item.language === language)
  };
}

export function mergeLanguageManifestItems(
  current: CodeBlockManifest,
  refreshed: CodeBlockManifest,
  language: MultisdkLanguage
): CodeBlockManifest {
  return {
    ...current,
    document: refreshed.document,
    documentId: refreshed.documentId,
    languageOrder: refreshed.languageOrder,
    items: [
      ...current.items.filter((item) => item.language !== language),
      ...refreshed.items.filter((item) => item.language === language)
    ]
  };
}

export async function writeLanguageScopedManifest(
  taskDir: string,
  manifest: CodeBlockManifest,
  language: MultisdkLanguage
): Promise<string> {
  const scopedPath = join(taskDir, `.multisdk-${language}-manifest.json`);
  await writeFile(scopedPath, `${JSON.stringify(filterManifestByLanguage(manifest, language), null, 2)}\n`, 'utf8');
  return scopedPath;
}
