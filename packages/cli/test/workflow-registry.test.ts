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

  it('gives safe next commands for a baseline sync', () => {
    const recipe = getWorkflowRecipe('baseline-sync');
    expect(recipe.title).toBe('Pull Feishu to local Markdown baseline');
    expect(recipe.steps.map((step) => step.id)).toEqual([
      'auth',
      'preview-pull',
      'review-diff',
      'replace-local',
      'status'
    ]);
    expect(recipe.steps[3].command).toContain('--overwrite');
    expect(recipe.steps[3].command).toContain('--write-receipt');
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
