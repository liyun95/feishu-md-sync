import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const fixture = (name: string) => new URL(
  `./fixtures/zdoc/model-providers/${name}`,
  import.meta.url
);

describe('model provider Zdoc round-trip fixtures', () => {
  it('records revision 790 to 799 as a Procedures-only change', async () => {
    const before = await readFile(fixture('revision-790.md'), 'utf8');
    const after = await readFile(fixture('revision-799.md'), 'utf8');
    const withoutTokens = after
      .replace('\n<Procedures>\n\n', '\n')
      .replace('\n</Procedures>\n\n', '\n');

    expect(withoutTokens).toBe(before);
  });

  it('records the canonical Procedures boundary', async () => {
    const source = await readFile(fixture('canonical-excerpt.md'), 'utf8');
    expect(source.indexOf('To create a model provider integration:'))
      .toBeLessThan(source.indexOf('<Procedures>'));
    expect(source.indexOf('<Procedures>'))
      .toBeLessThan(source.indexOf('1. Log in'));
  });
});
