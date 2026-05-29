#!/usr/bin/env node
import { Command } from 'commander';
import { registerCodeBlockCommands } from './commands/code-blocks.js';
import { registerHarnessCommands } from './commands/harness.js';
import { registerMultisdkCommands } from './commands/multisdk.js';
import { registerReferenceCommands } from './commands/reference.js';
import { registerReleaseCommands } from './commands/release.js';
import { registerSyncCommands } from './commands/sync.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { createCliContext } from './context.js';
import { buildAuthDoctorReport, loadCliEnv } from './env.js';
import { printFormatted } from './output.js';

const program = new Command();
const envLoadReport = loadCliEnv({ moduleUrl: import.meta.url });
const cliContext = createCliContext(envLoadReport);

registerSyncCommands(program, cliContext);

const doctor = program
  .command('doctor')
  .description('inspect local md2feishu configuration');

doctor
  .command('auth')
  .description('show where auth environment variables were loaded from without printing secrets')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (opts: FormatCommandOptions) => {
    printFormatted(buildAuthDoctorReport(envLoadReport), opts.format);
  });

registerHarnessCommands(program, cliContext);

registerCodeBlockCommands(program, cliContext);

registerMultisdkCommands(program, cliContext);

registerReferenceCommands(program, cliContext);

registerReleaseCommands(program, cliContext);

registerWorkflowCommands(program);

program.parseAsync().catch((error: unknown) => {
  const message = (error as Error).message;
  if (isRemoteConflictError(message)) {
    printRemoteConflictHelp(message);
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});

type FormatCommandOptions = {
  format?: string;
};

function isRemoteConflictError(message: string): boolean {
  return message.includes('Feishu changed since the last receipt');
}

function printRemoteConflictHelp(message: string): void {
  console.error('Conflict: Feishu changed since the last successful sync.');
  console.error('');
  console.error(message);
  console.error('');
  console.error('Nothing was written.');
  console.error('');
  console.error('Next steps:');
  console.error('  md2feishu status <file.md> <doc>');
  console.error('  md2feishu diff <file.md> <doc>');
  console.error('  md2feishu merge <file.md> <doc>');
  console.error('  md2feishu pull <doc> --output feishu.remote.md');
  console.error('  md2feishu push <file.md> <doc>');
  console.error('  md2feishu sync <file.md> <doc> --write --strategy local-wins --yes');
}
