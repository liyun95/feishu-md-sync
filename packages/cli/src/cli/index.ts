#!/usr/bin/env node
import { Command } from 'commander';
import { registerCoreCommands } from './commands/core.js';
import { registerPublishCommand } from './commands/publish.js';
import { buildAuthDoctorReport, loadCliEnv } from './env.js';
import { printFormatted } from './output.js';

const topLevelCommands = ['publish', 'status', 'pull', 'diff', 'merge', 'doctor', 'help'];

main().catch((error: unknown) => {
  const message = (error as Error).message;
  console.error(message);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const envLoadReport = loadCliEnv({ moduleUrl: import.meta.url });
  const program = new Command();

  program
    .name('feishu-md-sync')
    .description('Sync local Markdown with Feishu/Lark online documents. Defaults to dry-run for remote writes.');

  registerPublishCommand(program);
  registerCoreCommands(program);

  const doctor = program
    .command('doctor')
    .description('inspect local feishu-md-sync configuration');

  doctor
    .command('auth')
    .description('show lark-cli auth hints and loaded .env files')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: FormatCommandOptions) => {
      printFormatted(buildAuthDoctorReport(envLoadReport), opts.format);
    });

  const unknownCommand = findUnknownTopLevelCommand(process.argv.slice(2), topLevelCommands);
  if (unknownCommand) {
    throw new Error(`error: unknown command '${unknownCommand}'`);
  }

  await program.parseAsync();
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
