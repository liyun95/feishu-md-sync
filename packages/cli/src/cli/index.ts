#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { registerCoreCommands } from './commands/core.js';
import { registerPublishCommand } from './commands/publish.js';
import { normalizeCliFailure, validationFailure } from '../core/cli-failure.js';
import { renderCliFailure, requestedOutputFormat } from './error-output.js';
import { buildAuthDoctorReport, loadCliEnv } from './env.js';
import { parseOutputFormat, printFormatted } from './output.js';
import { CLI_VERSION } from './version.js';

const topLevelCommands = ['publish', 'status', 'pull', 'diff', 'merge', 'doctor', 'help'];

main().catch((error: unknown) => {
  const failure = error instanceof CommanderError
    ? validationFailure({ message: error.message })
    : normalizeCliFailure(error);
  renderCliFailure(failure, requestedOutputFormat(process.argv));
  process.exitCode = failure.exitCode;
});

async function main(): Promise<void> {
  const envLoadReport = loadCliEnv({ moduleUrl: import.meta.url });
  const program = new Command();

  program
    .name('feishu-md-sync')
    .version(CLI_VERSION)
    .description('Sync local Markdown with Feishu/Lark online documents. Defaults to dry-run for remote writes.')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });

  registerPublishCommand(program);
  registerCoreCommands(program);

  const doctor = program
    .command('doctor')
    .description('inspect local feishu-md-sync configuration');

  doctor
    .command('auth')
    .description('show lark-cli auth hints and loaded .env files')
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (opts: FormatCommandOptions) => {
      printFormatted(buildAuthDoctorReport(envLoadReport), opts.format);
    });

  const unknownCommand = findUnknownTopLevelCommand(process.argv.slice(2), topLevelCommands);
  if (unknownCommand) {
    throw new Error(`error: unknown command '${unknownCommand}'`);
  }

  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CommanderError && (
      error.code === 'commander.helpDisplayed' || error.code === 'commander.version'
    )) return;
    throw error;
  }
}

type FormatCommandOptions = {
  format?: string;
};

function findUnknownTopLevelCommand(args: string[], knownCommands: string[]): string | undefined {
  const known = new Set(knownCommands);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--env-file') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--env-file=')) continue;
    if (arg.startsWith('-')) continue;
    return known.has(arg) ? undefined : arg;
  }
  return undefined;
}
