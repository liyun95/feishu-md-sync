import type { Command } from 'commander';
import { getWorkflowRecipe, listWorkflowRecipes } from '../../workflows/registry.js';
import { printFormatted } from '../output.js';

type FormatCommandOptions = {
  format?: string;
};

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('show user-story oriented workflow recipes');

  workflow
    .command('list')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action((opts: FormatCommandOptions) => {
      printFormatted(listWorkflowRecipes().map(({ id, title, whenToUse }) => ({ id, title, whenToUse })), opts.format);
    });

  workflow
    .command('show')
    .argument('<workflow>', 'workflow id')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action((id: string, opts: FormatCommandOptions) => {
      printFormatted(getWorkflowRecipe(id), opts.format);
    });
}
