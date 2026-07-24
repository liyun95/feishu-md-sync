import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_NODE_VERSION = 'v24.18.0';
const REQUIRED_NPM_VERSION = '11.18.0';
const NPM_PACK_COMMAND = 'npm pack';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];

if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: node scripts/release-artifacts.mjs --write|--check');
}
if (process.version !== REQUIRED_NODE_VERSION) {
  throw new Error(`Release artifacts require Node ${REQUIRED_NODE_VERSION}, received ${process.version}.`);
}
const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
if (npmVersion !== REQUIRED_NPM_VERSION) {
  throw new Error(`Release artifacts require npm ${REQUIRED_NPM_VERSION}, received ${npmVersion}.`);
}

const cli = readJson('packages/cli/package.json');
const engine = readJson('packages/docx-engine/package.json');
const manifestPath = `.github/releases/v${cli.version}.json`;
const manifest = readJson(manifestPath);
validateManifestIdentity(manifest, cli, engine);

const temporaryRoot = mkdtempSync(join(tmpdir(), 'feishu-release-artifacts-'));
try {
  const first = packRound(join(temporaryRoot, 'first'));
  const second = packRound(join(temporaryRoot, 'second'));
  assertSameArtifact(first.engine, second.engine, 'engine');
  assertSameArtifact(first.cli, second.cli, 'CLI');

  const generated = {
    toolchain: { node: REQUIRED_NODE_VERSION.slice(1), npm: REQUIRED_NPM_VERSION },
    engine: artifactManifest(first.engine),
    cli: artifactManifest(first.cli),
  };

  if (mode === '--write') {
    const updated = {
      ...manifest,
      toolchain: generated.toolchain,
      cli: { ...manifest.cli, ...generated.cli },
      engine: { ...manifest.engine, ...generated.engine },
    };
    writeFileSync(join(root, manifestPath), `${JSON.stringify(updated, null, 2)}\n`);
  } else {
    assertManifestArtifact(manifest.engine, generated.engine, 'engine');
    assertManifestArtifact(manifest.cli, generated.cli, 'CLI');
    if (manifest.toolchain?.node !== generated.toolchain.node ||
        manifest.toolchain?.npm !== generated.toolchain.npm) {
      throw new Error('Release manifest toolchain does not match the pinned artifact toolchain.');
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: mode.slice(2),
    manifestPath,
    command: NPM_PACK_COMMAND,
    ...generated,
  }, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function packRound(directory) {
  mkdirSync(directory, { recursive: true });
  return {
    engine: packWorkspace('feishu-docx-engine', directory),
    cli: packWorkspace('feishu-md-sync', directory),
  };
}

function packWorkspace(workspace, directory) {
  const output = execFileSync('npm', [
    'pack',
    `--workspace=${workspace}`,
    '--json',
    '--pack-destination',
    directory,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [packed] = JSON.parse(output);
  if (!packed?.filename || !packed?.integrity || !packed?.name || !packed?.version) {
    throw new Error(`npm pack returned incomplete metadata for ${workspace}.`);
  }
  const bytes = readFileSync(join(directory, packed.filename));
  return {
    name: packed.name,
    version: packed.version,
    integrity: packed.integrity,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function assertSameArtifact(left, right, label) {
  if (left.name !== right.name || left.version !== right.version ||
      left.integrity !== right.integrity || left.sha256 !== right.sha256 ||
      left.bytes.length !== right.bytes.length || !timingSafeEqual(left.bytes, right.bytes)) {
    throw new Error(`Two pinned-toolchain ${label} packs were not byte-identical.`);
  }
}

function artifactManifest(artifact) {
  return {
    name: artifact.name,
    version: artifact.version,
    integrity: artifact.integrity,
    sha256: artifact.sha256,
  };
}

function assertManifestArtifact(expected, actual, label) {
  for (const field of ['name', 'version', 'integrity', 'sha256']) {
    if (expected?.[field] !== actual[field]) {
      throw new Error(
        `Release manifest ${label} ${field} does not match pinned-toolchain pack output: ` +
        `expected ${JSON.stringify(expected?.[field])}, received ${JSON.stringify(actual[field])}.`,
      );
    }
  }
}

function validateManifestIdentity(value, cliManifest, engineManifest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Release manifest ${manifestPath} must be an object.`);
  }
  if (value.schemaVersion !== 1 || value.tag !== `v${cliManifest.version}`) {
    throw new Error(`Release manifest ${manifestPath} does not match CLI ${cliManifest.version}.`);
  }
  if (value.cli?.name !== cliManifest.name || value.cli?.version !== cliManifest.version) {
    throw new Error('Release manifest CLI identity does not match packages/cli/package.json.');
  }
  if (value.engine?.name !== engineManifest.name || value.engine?.version !== engineManifest.version) {
    throw new Error('Release manifest engine identity does not match packages/docx-engine/package.json.');
  }
  if (cliManifest.dependencies?.['feishu-docx-engine'] !== engineManifest.version) {
    throw new Error('CLI must pin the exact engine version before packing release artifacts.');
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}
