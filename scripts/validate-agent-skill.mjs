import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skillDir = join(root, 'skills', 'feishu-md-sync');
const skillPath = join(skillDir, 'SKILL.md');
const metadataPath = join(skillDir, 'agents', 'openai.yaml');
const agentUsagePath = join(root, 'apps', 'docs', 'guide', 'agent-usage.md');
const cliPath = process.env.FEISHU_MD_SYNC_BIN || join(root, 'packages', 'cli', 'dist', 'cli', 'index.js');
const allowDevelopmentVersion = process.argv.includes('--allow-development-version');

const skill = readFileSync(skillPath, 'utf8');
const metadata = readFileSync(metadataPath, 'utf8');
const agentUsage = readFileSync(agentUsagePath, 'utf8');
const frontmatter = frontmatterFields(skill);

assert(frontmatter.name === 'feishu-md-sync', 'Skill frontmatter name must match its folder');
assert(typeof frontmatter.description === 'string' && frontmatter.description.length > 0, 'Skill description is required');
assert(frontmatter.description.startsWith('Use when '), 'Skill description must start with "Use when"');
assert(!skill.includes('TODO'), 'Skill contains a TODO placeholder');
assert(!skill.includes('md2feishu'), 'Skill must not reference the retired md2feishu CLI');
assert(skill.includes('>=0.5.0 <0.6.0'), 'Skill must declare the v0.5 compatibility range');
assert(skill.includes('dialectBlockers'), 'Skill must branch on dialect blockers');
assert(skill.includes('dialectDiagnostics'), 'Skill must branch on dialect diagnostics');
assert(skill.includes('linkResolution'), 'Skill must inspect link resolution');
assert(skill.includes('dialect-suggestion'), 'Skill must not silently switch suggested dialects');
assert(skill.includes('public-site fallback'), 'Skill must pause before public-site fallback writes');
assert(skill.includes('zdoc-authoring'), 'Skill must route canonical Zdoc sources through zdoc-authoring');
const removedZdocDialect = ['docu', 'saurus'].join('');
assert(!skill.includes(removedZdocDialect), 'Skill must not reference the removed legacy Zdoc dialect');
assert(skill.includes('canonical Zdoc source'), 'Skill must require the canonical source instead of a hidden publish view');
assert(skill.includes('destination role'), 'Skill must discover whether Feishu is a presentation target or authoring archive');
assert(skill.includes('zdocRoundTrip'), 'Skill must inspect the structured Zdoc round-trip report');
assert(skill.includes('Procedures'), 'Skill must verify Procedures boundaries');
assert(skill.includes('Supademo'), 'Skill must verify protected Supademo resources');
assert(skill.includes('readback'), 'Skill must require Zdoc readback verification');
assert(skill.includes('returned `document.url` or `document.documentId`'), 'Skill must verify creates against the returned document target');
assert(skill.includes('final Whiteboard-aware status'), 'Skill must preserve --sync-whiteboards during final verification');
assert(!agentUsage.includes('symlinked development copy'), 'Agent usage must not describe a copied local Skill as symlinked');

for (const expected of [
  'display_name: "Feishu Markdown Sync"',
  'short_description: "Safely sync local Markdown with Feishu documents"',
  'default_prompt: "Use $feishu-md-sync to inspect and synchronize local Markdown with a Feishu document using dry-run-first safety gates."'
]) {
  assert(metadata.includes(expected), `agents/openai.yaml is missing: ${expected}`);
}

const version = runCli(['--version']).trim();
const versionMatch = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
assert(versionMatch, `CLI version is not valid semver: ${version}`);

const topHelp = runCli(['--help']);
for (const command of ['publish', 'status', 'diff', 'pull', 'merge', 'baseline', 'doctor']) {
  assert(new RegExp(`^  ${command}(?:\\s|\\[|<)`, 'm').test(topHelp), `top-level help is missing ${command}`);
}

const publishHelp = runCli(['publish', '--help']);
assertHelpOptions('publish', publishHelp, [
  '--target',
  '--profile',
  '--dialect',
  '--write',
  '--create',
  '--strategy',
  '--confirm-destructive',
  '--confirm-collaboration-risk',
  '--confirm-untracked-remote',
  '--sync-whiteboards',
  '--confirm-remote-whiteboard-overwrite',
  '--format'
]);

const statusHelp = runCli(['status', '--help']);
assertHelpOptions('status', statusHelp, ['--target', '--profile', '--dialect', '--sync-whiteboards', '--format']);

const diffHelp = runCli(['diff', '--help']);
assertHelpOptions('diff', diffHelp, ['--target', '--profile', '--dialect', '--sync-whiteboards', '--format']);

const pullHelp = runCli(['pull', '--help']);
assertHelpOptions('pull', pullHelp, ['--target', '--output', '--profile', '--overwrite', '--format']);

const mergeHelp = runCli(['merge', '--help']);
assertHelpOptions('merge', mergeHelp, ['--target', '--profile', '--dialect', '--check', '--abort', '--format']);

const baselineAdoptHelp = runCli(['baseline', 'adopt', '--help']);
assertHelpOptions('baseline adopt', baselineAdoptHelp, [
  '--target',
  '--profile',
  '--dialect',
  '--local-baseline',
  '--git-ref',
  '--apply',
  '--confirm-baseline-adoption',
  '--format'
]);

const doctorAuthHelp = runCli(['doctor', 'auth', '--help']);
assertHelpOptions('doctor auth', doctorAuthHelp, ['--format']);

const major = Number(versionMatch[1]);
const minor = Number(versionMatch[2]);
const prerelease = versionMatch[4];
const stableCompatible = major === 0 && minor === 5 && prerelease === undefined;
const eligibleDevelopmentVersion = major === 0 && (minor < 5 || (minor === 5 && prerelease !== undefined));
if (!stableCompatible) {
  assert(
    allowDevelopmentVersion && eligibleDevelopmentVersion,
    `CLI ${version} is outside the Skill range >=0.5.0 <0.6.0; update the Skill compatibility range before validating a later release line`
  );
  process.stdout.write(`Agent Skill valid for development CLI ${version}; required command contract is present.\n`);
} else {
  process.stdout.write(`Agent Skill valid for CLI ${version}.\n`);
}

function runCli(args) {
  return execFileSync(cliPath, args, { cwd: root, encoding: 'utf8' });
}

function assertHelpOptions(command, help, options) {
  for (const option of options) {
    assert(help.includes(option), `${command} help is missing ${option}`);
  }
}

function frontmatterFields(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert(match, 'SKILL.md must start with YAML frontmatter');
  const result = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    assert(separator > 0, `Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    assert(key === 'name' || key === 'description', `Unsupported Skill frontmatter field: ${key}`);
    result[key] = value;
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
