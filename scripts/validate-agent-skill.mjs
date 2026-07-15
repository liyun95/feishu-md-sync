import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skillDir = join(root, 'skills', 'feishu-md-sync');
const skillPath = join(skillDir, 'SKILL.md');
const metadataPath = join(skillDir, 'agents', 'openai.yaml');
const cliPath = join(root, 'packages', 'cli', 'dist', 'cli', 'index.js');
const allowDevelopmentVersion = process.argv.includes('--allow-development-version');

const skill = readFileSync(skillPath, 'utf8');
const metadata = readFileSync(metadataPath, 'utf8');
const frontmatter = frontmatterFields(skill);

assert(frontmatter.name === 'feishu-md-sync', 'Skill frontmatter name must match its folder');
assert(typeof frontmatter.description === 'string' && frontmatter.description.length > 0, 'Skill description is required');
assert(!skill.includes('TODO'), 'Skill contains a TODO placeholder');
assert(!skill.includes('md2feishu'), 'Skill must not reference the retired md2feishu CLI');
assert(skill.includes('>=0.3.0 <0.4.0'), 'Skill must declare the v0.3 compatibility range');

for (const expected of [
  'display_name: "Feishu Markdown Sync"',
  'short_description: "Safely sync local Markdown with Feishu documents"',
  'default_prompt: "Use $feishu-md-sync to inspect and synchronize local Markdown with a Feishu document using dry-run-first safety gates."'
]) {
  assert(metadata.includes(expected), `agents/openai.yaml is missing: ${expected}`);
}

const version = runCli(['--version']).trim();
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `CLI version is not valid semver: ${version}`);

const topHelp = runCli(['--help']);
for (const command of ['publish', 'status', 'diff', 'pull', 'merge', 'doctor']) {
  assert(new RegExp(`^  ${command}(?:\\s|\\[|<)`, 'm').test(topHelp), `top-level help is missing ${command}`);
}

const publishHelp = runCli(['publish', '--help']);
for (const option of [
  '--write',
  '--create',
  '--strategy',
  '--confirm-destructive',
  '--confirm-collaboration-risk',
  '--confirm-untracked-remote',
  '--sync-whiteboards',
  '--confirm-remote-whiteboard-overwrite',
  '--format'
]) {
  assert(publishHelp.includes(option), `publish help is missing ${option}`);
}

const mergeHelp = runCli(['merge', '--help']);
assert(mergeHelp.includes('--check'), 'merge help is missing --check');

const [major, minor] = version.split('.').map(Number);
const stableCompatible = major === 0 && minor === 3;
if (!stableCompatible) {
  assert(
    allowDevelopmentVersion,
    `CLI ${version} is outside the Skill range >=0.3.0 <0.4.0; use only an explicit development validation before the release bump`
  );
  process.stdout.write(`Agent Skill valid for development CLI ${version}; required command contract is present.\n`);
} else {
  process.stdout.write(`Agent Skill valid for CLI ${version}.\n`);
}

function runCli(args) {
  return execFileSync(cliPath, args, { cwd: root, encoding: 'utf8' });
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
