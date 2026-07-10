#!/usr/bin/env node
import { Command } from 'commander';
import { registerCoreCommands } from './commands/core.js';
import { registerPublishCommand } from './commands/publish.js';
import { buildAuthDoctorReport, loadCliEnv } from './env.js';
import { printFormatted } from './output.js';

const program = new Command();
const envLoadReport = loadCliEnv({ moduleUrl: import.meta.url });

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
  .description('show where auth environment variables were loaded from without printing secrets')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (opts: FormatCommandOptions) => {
    printFormatted(buildAuthDoctorReport(envLoadReport), opts.format);
  });

program.parseAsync().catch((error: unknown) => {
  const message = (error as Error).message;
  console.error(message);
  process.exitCode = 1;
});

type FormatCommandOptions = {
  format?: string;
};
