import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validator = join(root, 'scripts', 'validate-agent-skill.mjs');
const tempDir = mkdtempSync(join(tmpdir(), 'feishu-md-sync-skill-validator-'));

try {
  expectResult(createFakeCli('0.4.0', fullHelp()), [], false, 'outside the Skill range');
  expectResult(createFakeCli('0.4.0', fullHelp()), ['--allow-development-version'], true);
  expectResult(createFakeCli('0.5.0', fullHelp()), [], true);
  expectResult(createFakeCli('0.5.0-rc.1', fullHelp()), [], false, 'outside the Skill range');

  const missingStatusFormat = fullHelp();
  missingStatusFormat.status = missingStatusFormat.status.replace('  --format <format>\n', '');
  expectResult(createFakeCli('0.2.0', missingStatusFormat), ['--allow-development-version'], false, 'status help is missing --format');

  const missingPullOutput = fullHelp();
  missingPullOutput.pull = missingPullOutput.pull.replace('  --output <file>\n', '');
  expectResult(createFakeCli('0.2.0', missingPullOutput), ['--allow-development-version'], false, 'pull help is missing --output');

  expectResult(createFakeCli('0.6.0', fullHelp()), ['--allow-development-version'], false, 'outside the Skill range');

  const missingPublishDialect = fullHelp();
  missingPublishDialect.publish = missingPublishDialect.publish.replace('  --dialect <dialect>\n', '');
  expectResult(
    createFakeCli('0.5.0', missingPublishDialect),
    [],
    false,
    'publish help is missing --dialect'
  );

  const missingBaselineConfirmation = fullHelp();
  missingBaselineConfirmation['baseline adopt'] = missingBaselineConfirmation['baseline adopt']
    .replace('  --confirm-baseline-adoption <fingerprint>\n', '');
  expectResult(
    createFakeCli('0.5.0', missingBaselineConfirmation),
    [],
    false,
    'baseline adopt help is missing --confirm-baseline-adoption'
  );
  process.stdout.write('Agent Skill validator regression checks passed.\n');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function createFakeCli(version, help) {
  const path = join(tempDir, `fake-${version}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(path, `#!/usr/bin/env node
const key = process.argv.slice(2).filter((arg) => arg !== '--help').join(' ');
if (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(`${version}\n`)});
else process.stdout.write((${JSON.stringify(help)})[key] ?? '');
`);
  chmodSync(path, 0o755);
  return path;
}

function fullHelp() {
  return {
    '': '  publish\n  status\n  diff\n  pull\n  merge\n  baseline\n  doctor\n',
    publish: [
      '  --target <target>',
      '  --profile <profile>',
      '  --dialect <dialect>',
      '  --write',
      '  --create',
      '  --strategy',
      '  --confirm-destructive',
      '  --confirm-collaboration-risk',
      '  --confirm-untracked-remote',
      '  --sync-whiteboards',
      '  --confirm-remote-whiteboard-overwrite',
      '  --format <format>'
    ].join('\n') + '\n',
    status: '  --target <target>\n  --profile <profile>\n  --dialect <dialect>\n  --sync-whiteboards\n  --format <format>\n',
    diff: '  --target <target>\n  --profile <profile>\n  --dialect <dialect>\n  --sync-whiteboards\n  --format <format>\n',
    pull: '  --target <target>\n  --output <file>\n  --profile <profile>\n  --overwrite\n  --format <format>\n',
    merge: '  --target <target>\n  --profile <profile>\n  --dialect <dialect>\n  --check\n  --abort\n  --format <format>\n',
    'baseline adopt': [
      '  --target <target>',
      '  --profile <profile>',
      '  --dialect <dialect>',
      '  --local-baseline <file>',
      '  --git-ref <ref>',
      '  --apply',
      '  --confirm-baseline-adoption <fingerprint>',
      '  --format <format>'
    ].join('\n') + '\n',
    'doctor auth': '  --format <format>\n'
  };
}

function expectResult(cliPath, args, succeeds, expectedMessage) {
  const result = spawnSync(process.execPath, [validator, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FEISHU_MD_SYNC_BIN: cliPath }
  });
  if ((result.status === 0) !== succeeds) {
    throw new Error(`unexpected validator result: ${result.stdout}${result.stderr}`);
  }
  if (expectedMessage && !result.stderr.includes(expectedMessage)) {
    throw new Error(`validator error did not include ${JSON.stringify(expectedMessage)}: ${result.stderr}`);
  }
}
