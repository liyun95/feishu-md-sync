import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = join(root, '.github', 'workflows', 'release.yml');
const workflow = parse(readFileSync(workflowPath, 'utf8'));
const liveFeishuWorkflow = parse(
  readFileSync(join(root, '.github', 'workflows', 'live-feishu.yml'), 'utf8'),
);
const releaseArtifactWorkflow = parse(
  readFileSync(join(root, '.github', 'workflows', 'release-artifacts.yml'), 'utf8'),
);
const provenanceRetryScript = readFileSync(
  join(root, '.github', 'scripts', 'verify-npm-provenance-with-retry.sh'),
  'utf8',
);
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const releaseChecklist = readFileSync(
  join(root, 'docs', 'plans', '2026-07-23-v0.6.3-release-recovery-checklist.md'),
  'utf8',
);
const cli = readJson('packages/cli/package.json');
const engine = readJson('packages/docx-engine/package.json');
const rootPackage = readJson('package.json');
const manifest = readJson(`.github/releases/v${cli.version}.json`);

assertRecord(workflow, 'release workflow');
assert(workflow.name === 'Publish npm packages', 'release workflow name must cover both packages');
assert(Array.isArray(workflow.on?.push?.tags) && workflow.on.push.tags.includes('v*'), 'release workflow must run on v* tags');

const publishJob = workflow.jobs?.publish;
assertRecord(publishJob, 'publish job');
assert(publishJob.environment === 'npm', 'publish job must use the protected npm environment');
assert(publishJob.permissions?.contents === 'read', 'publish job must keep contents read-only');
assert(publishJob.permissions?.['id-token'] === 'write', 'publish job must grant id-token: write for provenance');
assert(Array.isArray(publishJob.steps), 'publish job steps must be an array');
assert(rootPackage.packageManager === 'npm@11.18.0', 'root packageManager must pin the release npm version');
assert(
  Number(publishJob.env?.NPM_PROVENANCE_MAX_WAIT_SECONDS) >= 300,
  'release workflow must allow at least five minutes for npm provenance propagation',
);
assert(
  Number(publishJob.env?.NPM_PROVENANCE_RETRY_DELAY_SECONDS) > 0,
  'release workflow must configure a positive npm provenance retry delay',
);

validateManifest(manifest, cli, engine);
assert(
  readme.includes('`feishu-md-sync` 0.6 uses `feishu-docx-engine'),
  'README must describe the 0.6 engine dependency without release-candidate wording',
);
assert(
  !/unreleased[^\n]*feishu-md-sync[^\n]*0\.6|feishu-md-sync[^\n]*0\.6[^\n]*unreleased/i.test(readme),
  'README must not call feishu-md-sync 0.6 unreleased',
);
const releaseTag = `v${cli.version}`;
const taggedVerificationPreamble = `set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
test -z "$(git status --porcelain)"
test "$(git rev-parse --abbrev-ref HEAD)" = 'HEAD'
test "$(git describe --tags --exact-match)" = '${releaseTag}'`;
assert(
  releaseChecklist.includes(taggedVerificationPreamble),
  `release checklist must fail fast from a clean checkout detached at the exact ${releaseTag} tag`,
);
for (const expected of [
  `Run from a clean checkout detached at the immutable \`${releaseTag}\` tag`,
  'TEMP_HOME="$(mktemp -d)"',
  'CLI_PREFIX="$(mktemp -d)"',
  'node "$REPO_ROOT/scripts/hash-skill-tree.mjs"',
]) {
  assert(releaseChecklist.includes(expected), `release checklist is missing tagged verification guard: ${expected}`);
}
assert(
  !/Run in an empty directory after registry propagation/i.test(releaseChecklist),
  'release checklist must not invoke checkout scripts from an empty directory',
);
const reusedEngineManifest = structuredClone(manifest);
reusedEngineManifest.publishEngine = false;
reusedEngineManifest.engine.provenance = {
  tag: 'v0.5.0',
  ref: 'refs/tags/v0.5.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
};
validateManifest(reusedEngineManifest, cli, engine);
const invalidReusedEngineManifest = structuredClone(reusedEngineManifest);
invalidReusedEngineManifest.engine.provenance.commit = 'self';
expectFailure(
  () => validateManifest(invalidReusedEngineManifest, cli, engine),
  'reused engine provenance must reject a moving current-commit identity',
);

const steps = new Map(publishJob.steps.map((step) => [step.name, step]));
const setupNode = requiredStep(steps, 'Setup Node');
assert(
  setupNode.with?.['node-version'] === '24.18.0',
  'release workflow must pin the exact Node version used to generate artifact manifests',
);
assertRunContains(requiredStep(steps, 'Install pinned release tooling'), ['npm@11.18.0']);
const orderedNames = [
  'Checkout tagged release commit',
  'Install dependencies',
  'Load and validate release manifest',
  'Build workspace packages',
  'Typecheck',
  'Test',
  'Test coverage',
  'Build docs',
  'Smoke test npm package',
  'Validate release Agent Skill',
  'Validate dependency-ordered release workflow',
  'Pack engine and CLI release artifacts',
  'Verify packed artifacts against release manifest',
  'Publish engine with provenance',
  'Verify engine registry availability',
  'Verify engine provenance before CLI publication',
  'Smoke CLI candidate with registry-resolved engine',
  'Publish CLI with provenance',
  'Verify CLI registry and provenance',
  'Verify installed tagged Skill with released CLI',
];
assertStepOrder(publishJob.steps, orderedNames);

const buildWorkspace = requiredStep(steps, 'Build workspace packages');
assert(
  typeof buildWorkspace.run === 'string' && buildWorkspace.run.trim() === 'npm run build',
  'release workflow must build all workspace packages before root typecheck',
);

const manifestStep = requiredStep(steps, 'Load and validate release manifest');
assert(manifestStep.id === 'release_manifest', 'release manifest step must expose release_manifest outputs');
assertRunContains(manifestStep, [
  '.github/releases/${process.env.GITHUB_REF_NAME}.json',
  "cliManifest.dependencies['feishu-docx-engine']",
  'manifest.publishEngine',
  'provenance.commit',
  'engine_provenance_sha',
  'manifest.toolchain',
  "execFileSync('npm', ['--version']",
]);

const packStep = requiredStep(steps, 'Pack engine and CLI release artifacts');
assert(packStep.id === 'pack', 'pack step must expose artifact outputs');
assertRunContains(packStep, [
  'npm pack --workspace=feishu-docx-engine',
  'npm pack --workspace=feishu-md-sync',
]);

const hashGate = requiredStep(steps, 'Verify packed artifacts against release manifest');
assertRunContains(hashGate, [
  "createHash('sha256')",
  'engine.integrity !== manifest.engine.integrity',
  'cli.integrity !== manifest.cli.integrity',
  'engineSha256 !== manifest.engine.sha256',
  'cliSha256 !== manifest.cli.sha256',
]);

const publishEngine = requiredStep(steps, 'Publish engine with provenance');
assert(String(publishEngine.if).includes("steps.release_manifest.outputs.publish_engine == 'true'"), 'engine publish must be conditional on publishEngine');
assertRunContains(publishEngine, [
  'npm view "$PACKAGE_NAME@$PACKAGE_VERSION" dist.integrity',
  'npm publish "$ENGINE_TARBALL" --access public --provenance --tag latest',
]);

const engineRegistry = requiredStep(steps, 'Verify engine registry availability');
assertRunContains(engineRegistry, [
  'npm view "$PACKAGE_NAME@$PACKAGE_VERSION" dist.integrity',
  'PACKAGE_INTEGRITY',
]);

const engineProvenance = requiredStep(steps, 'Verify engine provenance before CLI publication');
assert(engineProvenance.if === undefined, 'engine provenance verification must run for new and reused engines');
assert(
  engineProvenance.env?.EXPECTED_REF === '${{ steps.release_manifest.outputs.engine_provenance_ref }}' &&
    engineProvenance.env?.EXPECTED_SHA === '${{ steps.release_manifest.outputs.engine_provenance_sha }}',
  'engine provenance must verify the manifest-recorded ref and commit',
);
assert(
  engineProvenance.env?.SIGSTORE_BUNDLE_PATH === 'release-artifacts/npm-provenance-engine.sigstore',
  'engine provenance must use a distinct Sigstore bundle',
);
assert(
  engineProvenance.env?.EXPECTED_CERTIFICATE_IDENTITY ===
    'https://github.com/${{ github.repository }}/.github/workflows/release.yml@${{ steps.release_manifest.outputs.engine_provenance_ref }}',
  'engine provenance must bind the shared verifier to the recorded release ref',
);
assertSharedProvenanceVerification(engineProvenance);

const consumer = requiredStep(steps, 'Smoke CLI candidate with registry-resolved engine');
assertRunContains(consumer, [
  'mktemp -d',
  'npm install --ignore-scripts --no-audit --no-fund "$CLI_TARBALL_ABSOLUTE"',
  'node_modules/feishu-docx-engine/package.json',
  '--version',
  'publish --help',
]);
assert(
  !/feishu-docx-engine-\d+\.\d+\.\d+\.tgz/.test(String(consumer.run)),
  'CLI consumer smoke must not install a local engine tarball',
);

const publishCli = requiredStep(steps, 'Publish CLI with provenance');
assertRunContains(publishCli, [
  'npm publish "$CLI_TARBALL" --access public --provenance --tag latest',
]);

const cliProvenance = requiredStep(steps, 'Verify CLI registry and provenance');
assert(
  cliProvenance.env?.EXPECTED_REF === '${{ github.ref }}' &&
    cliProvenance.env?.EXPECTED_SHA === '${{ github.sha }}',
  'CLI provenance must verify the current release ref and commit',
);
assert(
  cliProvenance.env?.SIGSTORE_BUNDLE_PATH === 'release-artifacts/npm-provenance-cli.sigstore',
  'CLI provenance must use a distinct Sigstore bundle',
);
assertSharedProvenanceVerification(cliProvenance);

assertRunContains({ name: 'shared npm provenance verifier', run: provenanceRetryScript }, [
  'download-npm-provenance.mjs',
  'sigstore verify',
  'verify-npm-provenance.mjs',
  'NPM_PROVENANCE_MAX_WAIT_SECONDS',
  'NPM_PROVENANCE_RETRY_DELAY_SECONDS',
]);

const liveFeishuSteps = liveFeishuWorkflow.jobs?.['live-feishu']?.steps;
assert(Array.isArray(liveFeishuSteps), 'live Feishu workflow steps must be an array');
assert(
  liveFeishuSteps.some((step) =>
    step.uses === 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10'),
  'live Feishu workflow must pin actions/checkout v6',
);
assert(
  liveFeishuSteps.some((step) =>
    step.uses === 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e'),
  'live Feishu workflow must pin actions/setup-node v6',
);

assertRecord(releaseArtifactWorkflow, 'release artifact workflow');
assert(releaseArtifactWorkflow.name === 'Verify release artifact manifest', 'release artifact workflow must have a stable name');
assert(
  Array.isArray(releaseArtifactWorkflow.on?.pull_request?.paths) &&
    releaseArtifactWorkflow.on.pull_request.paths.includes('.github/releases/**'),
  'release artifact workflow must run when a release manifest changes',
);
const artifactJob = releaseArtifactWorkflow.jobs?.verify;
assertRecord(artifactJob, 'release artifact verify job');
assert(artifactJob.permissions?.contents === 'read', 'release artifact workflow must keep contents read-only');
assert(Array.isArray(artifactJob.steps), 'release artifact workflow steps must be an array');
const artifactSteps = new Map(artifactJob.steps.map((step) => [step.name, step]));
const artifactSetupNode = requiredStep(artifactSteps, 'Setup Node');
assert(
  artifactSetupNode.with?.['node-version'] === '24.18.0',
  'release artifact workflow must use the manifest toolchain Node version',
);
assertRunContains(requiredStep(artifactSteps, 'Install pinned npm'), ['npm@11.18.0']);
assertRunContains(requiredStep(artifactSteps, 'Verify deterministic release artifacts'), ['npm run release:manifest:check']);
assert(
  rootPackage.scripts?.['release:manifest:write'] === 'node scripts/release-artifacts.mjs --write' &&
    rootPackage.scripts?.['release:manifest:check'] === 'node scripts/release-artifacts.mjs --check',
  'root scripts must expose pinned release manifest write and check commands',
);
const releaseArtifactScript = readFileSync(join(root, 'scripts', 'release-artifacts.mjs'), 'utf8');
for (const expected of ['v24.18.0', '11.18.0', 'npm pack', '--write', '--check', 'timingSafeEqual']) {
  assert(releaseArtifactScript.includes(expected), `release artifact script is missing ${expected}`);
}

const taggedSkill = requiredStep(steps, 'Verify installed tagged Skill with released CLI');
assertRunContains(taggedSkill, [
  'skills@1.5.17',
  'liyun95/feishu-md-sync#$GITHUB_REF_NAME',
  'hash-skill-tree.mjs',
  'FEISHU_MD_SYNC_SKILL_DIR',
  'FEISHU_MD_SYNC_BIN',
]);

const releaseJob = workflow.jobs?.release;
assertRecord(releaseJob, 'release job');
assert(releaseJob.needs === 'publish', 'GitHub Release must depend on the full publish job');

process.stdout.write('Structured release workflow and manifest checks passed.\n');

function validateManifest(value, cliManifest, engineManifest) {
  assertRecord(value, 'release manifest');
  assert(value.schemaVersion === 1, 'release manifest schemaVersion must be 1');
  assertRecord(value.toolchain, 'release manifest toolchain');
  assert(value.toolchain.node === '24.18.0', 'release manifest Node version must be exact');
  assert(value.toolchain.npm === '11.18.0', 'release manifest npm version must be exact');
  assert(value.tag === `v${cliManifest.version}`, 'release manifest tag must match CLI version');
  assert(typeof value.publishEngine === 'boolean', 'release manifest publishEngine must be boolean');
  validatePackage(value.cli, cliManifest.name, cliManifest.version, 'CLI');
  validatePackage(value.engine, engineManifest.name, engineManifest.version, 'engine');
  assert(
    cliManifest.dependencies?.['feishu-docx-engine'] === value.engine.version,
    'CLI dependency must exactly match manifest engine version',
  );
  assertRecord(value.engine.provenance, 'engine provenance identity');
  assert(/^v\d+\.\d+\.\d+$/.test(value.engine.provenance.tag), 'engine provenance tag must be a release tag');
  assert(value.engine.provenance.ref === `refs/tags/${value.engine.provenance.tag}`, 'engine provenance ref must match its tag');
  if (value.publishEngine) {
    assert(value.engine.provenance.tag === value.tag, 'new engine publication must bind provenance to the current tag');
    assert(value.engine.provenance.commit === 'self', 'new engine publication must use the current release commit');
  } else {
    assert(/^[0-9a-f]{40}$/.test(value.engine.provenance.commit), 'reused engine provenance must record its immutable commit SHA');
  }
}

function validatePackage(value, expectedName, expectedVersion, label) {
  assertRecord(value, `${label} manifest package`);
  assert(value.name === expectedName, `${label} manifest name must match package.json`);
  assert(value.version === expectedVersion, `${label} manifest version must match package.json`);
  assert(/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity), `${label} integrity must be sha512`);
  assert(/^[0-9a-f]{64}$/.test(value.sha256), `${label} SHA-256 must be lowercase hex`);
}

function assertStepOrder(allSteps, names) {
  let previous = -1;
  for (const name of names) {
    const index = allSteps.findIndex((step) => step.name === name);
    assert(index > previous, `release workflow step is missing or out of order: ${name}`);
    previous = index;
  }
}

function requiredStep(allSteps, name) {
  const step = allSteps.get(name);
  assertRecord(step, `workflow step ${name}`);
  return step;
}

function assertRunContains(step, values) {
  assert(typeof step.run === 'string', `${step.name} must be a run step`);
  for (const value of values) assert(step.run.includes(value), `${step.name} is missing ${value}`);
}

function assertSharedProvenanceVerification(step) {
  assert(
    step.run.trim() === 'bash .github/scripts/verify-npm-provenance-with-retry.sh',
    `${step.name} must use the shared npm provenance verifier`,
  );
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function assertRecord(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function expectFailure(operation, message) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
