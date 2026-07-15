import type { CliFailure } from '../core/cli-failure.js';

export type RequestedOutputFormat = 'pretty' | 'json';

export function requestedOutputFormat(argv: string[]): RequestedOutputFormat {
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const value = argv[index];
    if (value === '--format') return argv[index + 1] === 'json' ? 'json' : 'pretty';
    if (value.startsWith('--format=')) return value.slice('--format='.length) === 'json' ? 'json' : 'pretty';
  }
  return 'pretty';
}

export function renderCliFailure(failure: CliFailure, format: RequestedOutputFormat): void {
  if (format === 'json') {
    process.stderr.write(`${JSON.stringify({ ok: false, error: failure.details }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`${failure.message}\n`);
  if (failure.details.hint) process.stderr.write(`hint: ${failure.details.hint}\n`);
}
