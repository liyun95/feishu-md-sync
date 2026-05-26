import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { CodeBlockInventory } from '../feishu/code-blocks.js';
import {
  planCodeBlockManifest,
  type CodeBlockManifest,
  type CodeBlockManifestItem
} from './code-block-plan.js';

export type ExportCodeBlockSnippetsOptions = {
  document: string;
  inventory: CodeBlockInventory;
  expectLanguages: string[];
  outDir: string;
  manifestPath: string;
};

export type ExportCodeBlockSnippetsResult = {
  manifest: CodeBlockManifest;
  files: string[];
};

export async function exportCodeBlockSnippets(
  options: ExportCodeBlockSnippetsOptions
): Promise<ExportCodeBlockSnippetsResult> {
  const manifest = planCodeBlockManifest({
    document: options.document,
    inventory: options.inventory,
    expectLanguages: options.expectLanguages,
    snippetsDir: 'snippets'
  });
  const files: string[] = [];

  for (const item of manifest.items) {
    const targetPath = resolve(options.outDir, item.file);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, contentForItem(options.inventory, item), 'utf8');
    files.push(targetPath);
  }

  const manifestPath = resolve(options.manifestPath);
  const serializableManifest = relativizeManifestFiles(manifest, dirname(manifestPath));
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(serializableManifest, null, 2)}\n`, 'utf8');

  return {
    manifest: serializableManifest,
    files
  };
}

export async function loadCodeBlockManifest(path: string): Promise<CodeBlockManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as CodeBlockManifest;
}

function contentForItem(inventory: CodeBlockInventory, item: CodeBlockManifestItem): string {
  if (item.action === 'insert') return '';
  return inventory.blocks.find((block) => block.blockId === item.blockId)?.text ?? '';
}

function relativizeManifestFiles(manifest: CodeBlockManifest, manifestDir: string): CodeBlockManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) => ({
      ...item,
      file: isAbsolute(item.file) ? relative(manifestDir, item.file) : item.file
    }))
  };
}
