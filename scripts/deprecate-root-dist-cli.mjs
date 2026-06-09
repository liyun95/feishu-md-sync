#!/usr/bin/env node

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');

export const rootDistCliPath = 'dist/cli/index.js';

export function rootDistDeprecationShim() {
  return `#!/usr/bin/env node

console.error([
  'Deprecated md2feishu entrypoint.',
  '',
  'The root dist CLI at /Users/liyun/feishu-md-sync/dist/cli/index.js is stale and has been disabled.',
  'Use the workspace package CLI instead:',
  '',
  '  node /Users/liyun/feishu-md-sync/packages/cli/dist/cli/index.js <command>',
  '',
  'If the package CLI is missing or outdated, rebuild it first:',
  '',
  '  cd /Users/liyun/feishu-md-sync && npm run build',
  '',
  'Do not use this root dist entrypoint for Feishu push workflows.'
].join('\\n'));

process.exitCode = 1;
`;
}

export async function installRootDistDeprecationShim(repoRoot = defaultRepoRoot) {
  const shimPath = join(repoRoot, rootDistCliPath);
  await mkdir(dirname(shimPath), { recursive: true });
  await writeFile(shimPath, rootDistDeprecationShim());
  await chmod(shimPath, 0o755);
  return shimPath;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : defaultRepoRoot;
  const shimPath = await installRootDistDeprecationShim(repoRoot);
  console.log(`Deprecated root dist CLI shim installed at ${shimPath}`);
}
