import type { Command } from 'commander';
import { buildHarnessEnvironmentReport, writeHarnessEnvironment, type HarnessPathCheckInput } from '../../harness/environment.js';
import { gradeHarnessTask } from '../../harness/grade.js';
import { writeHarnessGradeArtifacts } from '../../harness/multisdk-grade.js';
import { getHarnessTools, parseHarnessWorkflow } from '../../harness/tools.js';
import type { CliContext } from '../context.js';
import { printFormatted, setFailedExitCode } from '../output.js';

type FormatCommandOptions = {
  format?: string;
};

type HarnessEnvCommandOptions = FormatCommandOptions & {
  milvusDocs?: string;
  webContentRepo?: string;
  sdkRepo?: string[];
};

type HarnessToolsCommandOptions = FormatCommandOptions & {
  workflow: string;
};

type HarnessGradeCommandOptions = FormatCommandOptions & {
  workflow: string;
};

export function registerHarnessCommands(program: Command, context: CliContext): void {
  const harness = program
    .command('harness')
    .description('inspect harness environment, tools, trace, and grading artifacts');

  harness
    .command('env')
    .description('print the local harness environment report')
    .option('--milvus-docs <path>', 'optional local Milvus docs repository path')
    .option('--web-content-repo <path>', 'optional local web-content repository path')
    .option('--sdk-repo <path>', 'repeatable local SDK repository path', collectOption, [])
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: HarnessEnvCommandOptions) => {
      const report = await buildHarnessEnvironmentReport({
        envLoadReport: context.envLoadReport,
        pathChecks: harnessPathChecks(opts)
      });
      printFormatted(report, opts.format);
    });

  harness
    .command('tools')
    .description('print the allowed harness tool registry for a workflow')
    .requiredOption('--workflow <workflow>', 'workflow id, for example multisdk or sdk-reference-authoring')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: HarnessToolsCommandOptions) => {
      printFormatted(getHarnessTools(parseHarnessWorkflow(opts.workflow)), opts.format);
    });

  harness
    .command('grade')
    .description('grade a task directory using workflow-specific harness rules')
    .argument('<task-dir>', 'task directory')
    .requiredOption('--workflow <workflow>', 'workflow id, for example multisdk or sdk-reference-authoring')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: HarnessGradeCommandOptions) => {
      const workflow = parseHarnessWorkflow(opts.workflow);
      const environment = await buildHarnessEnvironmentReport({ envLoadReport: context.envLoadReport });
      await writeHarnessEnvironment(taskDir, environment);
      const grade = await gradeHarnessTask({ taskDir, workflow });
      await writeHarnessGradeArtifacts(taskDir, grade);
      printFormatted(grade, opts.format);
      setFailedExitCode(grade.result === 'blocked');
    });
}

function harnessPathChecks(opts: HarnessEnvCommandOptions): HarnessPathCheckInput[] {
  return [
    opts.milvusDocs ? { name: 'milvusDocs', path: opts.milvusDocs } : undefined,
    opts.webContentRepo ? { name: 'webContentRepo', path: opts.webContentRepo } : undefined,
    ...(opts.sdkRepo ?? []).map((path, index) => ({ name: `sdkRepo${index + 1}`, path }))
  ].filter((item): item is HarnessPathCheckInput => Boolean(item));
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
