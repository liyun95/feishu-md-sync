import type { PublishProfileName } from '../profiles/publish-profile.js';
import { applyZillizPublishTransform } from '../transform/zilliz-publish.js';

export function applyPublishTransformForProfile(markdown: string, profile: PublishProfileName): { markdown: string; warnings: string[] } {
  if (profile === 'zilliz') return applyZillizPublishTransform(markdown);
  return { markdown, warnings: [] };
}
