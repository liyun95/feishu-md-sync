export const PUBLISH_PROFILES = ['zilliz', 'milvus', 'none'] as const;

export type PublishProfileName = typeof PUBLISH_PROFILES[number];

export type PublishProfileConfig = {
  includeTargets?: string[];
  excludeTargets?: string[];
  productNameMarkup?: boolean;
};

export function isPublishProfileName(value: string): value is PublishProfileName {
  return (PUBLISH_PROFILES as readonly string[]).includes(value);
}

export function parsePublishProfileName(value: string, label: string): PublishProfileName {
  if (isPublishProfileName(value)) return value;
  throw new Error(`Invalid ${label} ${value}. Expected zilliz, milvus, or none.`);
}
