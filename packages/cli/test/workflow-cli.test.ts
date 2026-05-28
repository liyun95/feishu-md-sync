import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('workflow CLI', () => {
  it('prints workflow recipes as JSON', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', 'workflow', 'list', '--format', 'json'], {
      cwd: new URL('..', import.meta.url)
    });
    const recipes = JSON.parse(stdout) as Array<{ id: string }>;
    expect(recipes.map((recipe) => recipe.id)).toContain('multisdk-examples');
  });

  it('shows one workflow recipe as JSON', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', 'workflow', 'show', 'sdk-reference-authoring', '--format', 'json'], {
      cwd: new URL('..', import.meta.url)
    });
    const recipe = JSON.parse(stdout) as { id: string; steps: Array<{ command: string }> };
    expect(recipe.id).toBe('sdk-reference-authoring');
    expect(recipe.steps.some((step) => step.command.includes('reference audit'))).toBe(true);
  });
});
