import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SyncReceipt = {
  sourcePath: string;
  sourceHash: string;
  sourceSnapshot?: string;
  feishuDocId: string;
  feishuStateHash: string;
  feishuMarkdownSnapshot?: string;
  timestamp: string;
  blockCounts: {
    source: number;
    feishuBefore: number;
    feishuAfter: number;
  };
  warnings: string[];
  writeResult: {
    mode: 'dry-run' | 'write';
    deleted: number;
    created: number;
    skipped: boolean;
  };
  verificationResult: {
    ok: boolean;
    expectedHash: string;
    actualHash: string;
  };
  runContext?: SyncReceiptRunContext;
};

export type SyncReceiptRunContext = {
  appIdPreview?: string;
  loadedEnvFiles: string[];
  explicitEnvFile?: string;
  feishuHost: string;
  activeTransforms: string[];
};

export function receiptPath(rootDir: string, sourcePath: string, docId: string): string {
  const basename = path.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(rootDir, '.sync', 'feishu', `${basename}.${docId}.json`);
}

export async function readReceipt(filePath: string): Promise<SyncReceipt | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as SyncReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeReceipt(filePath: string, receipt: SyncReceipt): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}
