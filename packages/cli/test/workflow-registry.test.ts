import { describe, expect, it } from 'vitest';
import { getWorkflowRecipe, listWorkflowRecipes } from '../src/workflows/registry.js';

describe('workflow registry', () => {
  it('lists user-story oriented workflows', () => {
    expect(listWorkflowRecipes().map((recipe) => recipe.id)).toEqual([
      'baseline-sync',
      'section-sync',
      'multisdk-examples',
      'sdk-reference-authoring',
      'sdk-reference-web-content-release',
      'release-notes'
    ]);
  });

  it('gives concrete next commands for a baseline sync', () => {
    const recipe = getWorkflowRecipe('baseline-sync');
    expect(recipe.title).toBe('Pull Feishu to local Markdown baseline');
    expect(recipe.steps[0].command).toBe('md2feishu doctor auth');
    expect(recipe.steps.some((step) => step.command.includes('md2feishu pull'))).toBe(true);
  });

  it('keeps SDK reference authoring separate from web-content release', () => {
    const authoring = getWorkflowRecipe('sdk-reference-authoring');
    const release = getWorkflowRecipe('sdk-reference-web-content-release');

    expect(authoring.steps.every((step) => !step.command.includes('reference export'))).toBe(true);
    expect(authoring.steps.every((step) => step.writes !== 'external-repo')).toBe(true);
    expect(release.whenToUse).toContain('human');
    expect(release.steps.some((step) => step.command.includes('reference export'))).toBe(true);
  });
});
