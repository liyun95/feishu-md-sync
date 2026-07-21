import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const sourceDir = join(packageDir, 'src');
const tempDir = mkdtempSync(join(tmpdir(), 'feishu-docx-engine-package-'));
const packageManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

try {
  if (packageManifest.license !== 'MIT') {
    throw new Error(`package license differs: expected MIT, got ${String(packageManifest.license)}`);
  }
  if (packageManifest.repository?.directory !== 'packages/docx-engine') {
    throw new Error('package repository.directory must identify packages/docx-engine');
  }
  if (packageManifest.exports?.['.']?.import !== './dist/index.js' ||
      packageManifest.exports?.['.']?.types !== './dist/index.d.ts') {
    throw new Error('package root export must declare runtime and type entrypoints');
  }
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

  for (const requiredPath of ['README.md', 'LICENSE', 'package.json', 'dist/index.js', 'dist/index.d.ts']) {
    if (!packedPaths.has(requiredPath)) throw new Error(`package is missing ${requiredPath}`);
  }

  const allowedRootPaths = new Set(['README.md', 'LICENSE', 'package.json']);
  const unexpectedPackedPaths = [...packedPaths]
    .filter((path) => !path.startsWith('dist/'))
    .filter((path) => !allowedRootPaths.has(path));
  if (unexpectedPackedPaths.length > 0) {
    throw new Error(`package contains unexpected files:\n${unexpectedPackedPaths.join('\n')}`);
  }

  const consumerDir = join(tempDir, 'consumer');
  mkdirSync(consumerDir);
  writeFileSync(join(consumerDir, 'package.json'), '{"private":true,"type":"module"}', 'utf8');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(tempDir, packed.filename)],
    { cwd: consumerDir, stdio: 'inherit' }
  );

  writeFileSync(join(consumerDir, 'runtime.mjs'), `
import { createFeishuDocxEngine, LarkCliTransport, ENGINE_VERSION } from 'feishu-docx-engine';

if (typeof createFeishuDocxEngine !== 'function') throw new Error('createFeishuDocxEngine is not a runtime export');
if (typeof LarkCliTransport !== 'function') throw new Error('LarkCliTransport is not a runtime export');
if (ENGINE_VERSION !== ${JSON.stringify(packageManifest.version)}) {
  throw new Error(\`ENGINE_VERSION differs: expected ${packageManifest.version}, got \${ENGINE_VERSION}\`);
}

const transport = new LarkCliTransport({
  exec: async () => ({ stdout: '{"ok":true,"data":{}}', stderr: '' })
});
const engine = createFeishuDocxEngine({ transport });
if (typeof engine.snapshot !== 'function' || typeof engine.prepare !== 'function' ||
    typeof engine.apply !== 'function' || typeof engine.assessRecovery !== 'function') {
  throw new Error('createFeishuDocxEngine returned an incomplete engine surface');
}
`, 'utf8');
  execFileSync(process.execPath, ['runtime.mjs'], { cwd: consumerDir, stdio: 'inherit' });

  writeFileSync(join(consumerDir, 'types.ts'), `
import {
  createFeishuDocxEngine,
  LarkCliTransport,
  ENGINE_VERSION,
  type DocxTransport,
  type DocumentSnapshot,
  type FeishuDocxEngine,
  type MutationIntent,
  type PartialMutationEvidence,
} from 'feishu-docx-engine';

const transport: DocxTransport = new LarkCliTransport({
  exec: async () => ({ stdout: '{"ok":true,"data":{}}', stderr: '' }),
});
const engine: FeishuDocxEngine = createFeishuDocxEngine({ transport });
const version: string = ENGINE_VERSION;
const snapshot: DocumentSnapshot | undefined = undefined;
const intent: MutationIntent | undefined = undefined;
const evidence: PartialMutationEvidence | undefined = undefined;
void [engine, version, snapshot, intent, evidence];
`, 'utf8');
  writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      skipLibCheck: false
    },
    include: ['types.ts']
  }, null, 2), 'utf8');
  execFileSync(
    process.execPath,
    [join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    { cwd: consumerDir, stdio: 'inherit' }
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
