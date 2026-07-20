import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(packageDir, 'src');
const tempDir = mkdtempSync(join(tmpdir(), 'feishu-md-sync-package-'));
const packageManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

try {
  assertLocalBinExecutable();
  assertNpmNormalizedManifest();

  const packOutput = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', tempDir],
    { cwd: packageDir, encoding: 'utf8' }
  );
  const [packed] = JSON.parse(packOutput);
  const packedPaths = new Set(packed.files.map((file) => file.path));
  const expectedDistPaths = new Set(
    walk(sourceDir)
      .filter((path) => path.endsWith('.ts'))
      .flatMap((path) => {
        const output = relative(sourceDir, path).split(sep).join('/').replace(/\.ts$/, '');
        return [`dist/${output}.js`, `dist/${output}.d.ts`];
      })
  );

  const unexpectedDistPaths = [...packedPaths]
    .filter((path) => path.startsWith('dist/'))
    .filter((path) => !expectedDistPaths.has(path));
  if (unexpectedDistPaths.length > 0) {
    throw new Error(`package contains stale dist files:\n${unexpectedDistPaths.join('\n')}`);
  }

  const missingDistPaths = [...expectedDistPaths].filter((path) => !packedPaths.has(path));
  if (missingDistPaths.length > 0) {
    throw new Error(`package is missing compiled files:\n${missingDistPaths.join('\n')}`);
  }

  for (const requiredPath of ['README.md', 'LICENSE', 'NOTICE', 'package.json', 'dist/cli/index.js']) {
    if (!packedPaths.has(requiredPath)) {
      throw new Error(`package is missing ${requiredPath}`);
    }
  }

  const allowedRootPaths = new Set(['README.md', 'LICENSE', 'NOTICE', 'package.json']);
  const unexpectedPackedPaths = [...packedPaths]
    .filter((path) => !path.startsWith('dist/'))
    .filter((path) => !allowedRootPaths.has(path));
  if (unexpectedPackedPaths.length > 0) {
    throw new Error(`package contains unexpected files:\n${unexpectedPackedPaths.join('\n')}`);
  }

  const consumerDir = join(tempDir, 'consumer');
  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, 'package.json'), '{"private":true}', 'utf8');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(tempDir, packed.filename)],
    { cwd: consumerDir, stdio: 'inherit' }
  );

  const binPath = join(
    consumerDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'feishu-md-sync.cmd' : 'feishu-md-sync'
  );
  const help = execFileSync(binPath, ['--help'], { cwd: consumerDir, encoding: 'utf8' });
  const version = execFileSync(binPath, ['--version'], { cwd: consumerDir, encoding: 'utf8' }).trim();
  if (version !== packageManifest.version) {
    throw new Error(`packaged CLI version differs: expected ${packageManifest.version}, got ${version}`);
  }
  const actualCommands = [...help.matchAll(/^  ([a-z][\w-]*)(?:\s|\[|<)/gm)]
    .map((match) => match[1])
    .sort();
  const expectedCommands = ['baseline', 'diff', 'doctor', 'help', 'merge', 'publish', 'pull', 'status'];
  if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommands)) {
    throw new Error(`packaged CLI commands differ: expected ${expectedCommands.join(', ')}, got ${actualCommands.join(', ')}`);
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function assertLocalBinExecutable() {
  if (process.platform === 'win32') return;
  const binPath = join(packageDir, 'dist', 'cli', 'index.js');
  if ((statSync(binPath).mode & 0o111) === 0) {
    throw new Error('local CLI entrypoint is not executable after build');
  }
}

function assertNpmNormalizedManifest() {
  const manifestPath = join(packageDir, 'package.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fixtureDir = join(tempDir, 'manifest');
  mkdirSync(join(fixtureDir, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(fixtureDir, 'package.json'), `${JSON.stringify(original, null, 2)}\n`, 'utf8');
  writeFileSync(join(fixtureDir, 'dist', 'cli', 'index.js'), '#!/usr/bin/env node\n', 'utf8');
  execFileSync('npm', ['pkg', 'fix'], { cwd: fixtureDir, stdio: 'pipe' });
  const normalized = JSON.parse(readFileSync(join(fixtureDir, 'package.json'), 'utf8'));
  if (JSON.stringify(normalized) !== JSON.stringify(original)) {
    throw new Error('package.json is not npm-normalized; run npm pkg fix and review the changes');
  }
}
