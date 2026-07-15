import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'feishu-md-sync-skill-'));
const source = join(root, 'skills', 'feishu-md-sync');

try {
  execFileSync('npx', [
    '--yes',
    'skills@1.5.17',
    'add',
    root,
    '--skill',
    'feishu-md-sync',
    '--agent',
    'codex',
    '--global',
    '--copy',
    '--yes'
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_STATE_HOME: join(tempHome, '.local', 'state')
    },
    stdio: 'pipe'
  });

  const installed = join(tempHome, '.agents', 'skills', 'feishu-md-sync');
  for (const relativePath of ['SKILL.md', join('agents', 'openai.yaml')]) {
    const expected = readFileSync(join(source, relativePath), 'utf8');
    const actual = readFileSync(join(installed, relativePath), 'utf8');
    if (actual !== expected) throw new Error(`installed Skill differs at ${relativePath}`);
  }
  process.stdout.write('Agent Skill install smoke passed with skills@1.5.17.\n');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
