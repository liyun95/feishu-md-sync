import type { PublishProfileName } from '../profiles/publish-profile.js';

export type PullTransformResult = {
  markdown: string;
  warnings: string[];
};

const SUPPORTED_TARGETS = new Set(['milvus', 'zilliz']);
const TAG_PATTERN = /<(include|exclude)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const TARGET_ATTR_PATTERN = /\btarget\s*=\s*["']([^"']+)["']/;

export function applyPullTransformForProfile(markdown: string, profile: PublishProfileName): PullTransformResult {
  if (profile === 'none') return { markdown, warnings: [] };

  const warnings: string[] = [];
  const transformed = markdown.replace(TAG_PATTERN, (full: string, tagName: string, attrs: string, content: string) => {
    const targets = parseTargets(attrs);
    if (!targets) {
      warnings.push(`${tagName} tag without target attribute was left unchanged.`);
      return full;
    }
    const unsupportedTargets = targets.filter((target) => !SUPPORTED_TARGETS.has(target));
    if (unsupportedTargets.length > 0) {
      warnings.push(`Unsupported ${tagName} target "${unsupportedTargets.join(', ')}"; left tag unchanged.`);
      return full;
    }

    const matches = targets.includes(profile);
    if (tagName === 'include') return matches ? content : '';
    return matches ? '' : content;
  });

  return { markdown: transformed, warnings };
}

function parseTargets(attrs: string): string[] | undefined {
  const match = attrs.match(TARGET_ATTR_PATTERN);
  if (!match) return undefined;
  return match[1]
    .split(/[,\s]+/)
    .map((target) => target.trim())
    .filter(Boolean);
}
