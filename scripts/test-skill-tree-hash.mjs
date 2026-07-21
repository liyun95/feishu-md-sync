import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashSkillTree } from './hash-skill-tree.mjs';

const root = mkdtempSync(join(tmpdir(), 'feishu-md-sync-skill-hash-'));
const first = join(root, 'first');
const second = join(root, 'second');

try {
  writeTree(first, [['SKILL.md', 'same\n'], ['agents/openai.yaml', 'metadata\n']]);
  writeTree(second, [['agents/openai.yaml', 'metadata\n'], ['SKILL.md', 'same\n']]);
  const expected = hashSkillTree(first);
  if (hashSkillTree(second) !== expected) throw new Error('Skill tree hash must ignore filesystem creation order');
  writeFileSync(join(second, 'SKILL.md'), 'changed\n', 'utf8');
  if (hashSkillTree(second) === expected) throw new Error('Skill tree hash must change with file content');
  process.stdout.write('Skill tree hash regression checks passed.\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeTree(directory, files) {
  for (const [relativePath, content] of files) {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
}
