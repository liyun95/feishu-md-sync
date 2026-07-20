import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items = Array.from(
      value,
      (item) => canonicalJson(item) ?? 'null',
    );
    return `[${items.join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = canonicalJson((value as Record<string, unknown>)[key]);
      if (item !== undefined) {
        entries.push(`${JSON.stringify(key)}:${item}`);
      }
    }
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

export function canonicalHash(value: unknown): string {
  const serialized = canonicalJson(value);
  if (serialized === undefined) {
    throw new TypeError('canonicalHash requires a JSON-serializable value');
  }

  return createHash('sha256').update(serialized).digest('hex');
}
