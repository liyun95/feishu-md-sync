import { access, readFile } from 'node:fs/promises';
import { dirname, extname, posix, relative, resolve } from 'node:path';
import { sha256 } from '../core/hash.js';
import { splitMarkdownImageBlocks } from '../semantic/markdown-image.js';
import type { SemanticAssetNode, SemanticDocument, SemanticLocator } from '../semantic/types.js';
import { validateWhiteboardSvg } from './svg-validation.js';

export type LocalWhiteboardAsset = {
  assetKey: string;
  locator: SemanticLocator;
  alt: string;
  pngPath: string;
  svgPath: string;
  svgSource: string;
  svgHash: string;
  expectedTexts: string[];
};

export type LocalWhiteboardBlocker = {
  code: 'missing-local-png' | 'missing-local-svg' | 'invalid-svg' | 'inline-whiteboard-unsupported';
  assetKey: string;
  message: string;
};

export async function discoverLocalWhiteboardAssets(input: {
  sourcePath: string;
  markdown: string;
  document: SemanticDocument;
  tracked: Array<{ assetKey: string; svgPath: string }>;
}): Promise<{ assets: LocalWhiteboardAsset[]; blockers: LocalWhiteboardBlocker[] }> {
  const assets: LocalWhiteboardAsset[] = [];
  const blockers: LocalWhiteboardBlocker[] = [];
  const sourceDir = dirname(input.sourcePath);
  const trackedKeys = new Set(input.tracked.map((entry) => normalizeAssetKey(entry.assetKey)));

  for (const node of input.document.nodes.filter(isLocalImageAsset)) {
    const local = localPngPath(node.source, sourceDir);
    if (!local) continue;
    const tracked = trackedKeys.has(local.assetKey);
    const pngExists = await fileExists(local.pngPath);
    const svgExists = await fileExists(local.svgPath);

    if (!pngExists) {
      if (tracked || svgExists) {
        blockers.push({
          code: 'missing-local-png',
          assetKey: local.assetKey,
          message: `local PNG is missing: ${local.assetKey}`
        });
      }
      continue;
    }
    if (!svgExists) {
      if (tracked) {
        blockers.push({
          code: 'missing-local-svg',
          assetKey: local.assetKey,
          message: `tracked Whiteboard SVG is missing: ${normalizeAssetKey(relative(sourceDir, local.svgPath))}`
        });
      }
      continue;
    }

    const svgSource = await readFile(local.svgPath, 'utf8');
    const validation = validateWhiteboardSvg(svgSource);
    if (!validation.valid) {
      blockers.push({
        code: 'invalid-svg',
        assetKey: local.assetKey,
        message: `invalid Whiteboard SVG ${local.assetKey}: ${validation.issues.map((issue) => issue.message).join('; ')}`
      });
      continue;
    }
    assets.push({
      assetKey: local.assetKey,
      locator: node.locator,
      alt: node.alt ?? '',
      pngPath: local.pngPath,
      svgPath: local.svgPath,
      svgSource,
      svgHash: sha256(svgSource),
      expectedTexts: validation.expectedTexts
    });
  }

  for (const segment of splitMarkdownImageBlocks(input.markdown)) {
    if (segment.kind !== 'inline-image') continue;
    for (const image of segment.images) {
      const local = localPngPath(image.source, sourceDir);
      if (!local) continue;
      if (!await fileExists(local.pngPath) || !await fileExists(local.svgPath)) continue;
      blockers.push({
        code: 'inline-whiteboard-unsupported',
        assetKey: local.assetKey,
        message: `Whiteboard image must be on its own Markdown line: ${local.assetKey}`
      });
    }
  }

  return { assets, blockers };
}

export function normalizeAssetKey(value: string): string {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function isLocalImageAsset(node: SemanticDocument['nodes'][number]): node is SemanticAssetNode & { source: string } {
  return node.kind === 'asset' && node.representation === 'image' && typeof node.source === 'string';
}

function localPngPath(source: string, sourceDir: string): {
  assetKey: string;
  pngPath: string;
  svgPath: string;
} | undefined {
  if (/^(?:https?:|data:)/i.test(source)) return undefined;
  const withoutSuffix = source.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    decoded = withoutSuffix;
  }
  if (extname(decoded).toLocaleLowerCase('en-US') !== '.png') return undefined;
  const pngPath = resolve(sourceDir, decoded);
  const svgPath = `${pngPath.slice(0, -extname(pngPath).length)}.svg`;
  return {
    assetKey: normalizeAssetKey(relative(sourceDir, pngPath)),
    pngPath,
    svgPath
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
