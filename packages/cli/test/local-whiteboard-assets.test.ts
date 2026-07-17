import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localSemanticDocument } from '../src/semantic/local-document.js';
import { discoverLocalWhiteboardAssets, normalizeAssetKey } from '../src/whiteboards/local-assets.js';

describe('local Whiteboard assets', () => {
  it('loads a same-name SVG beside a referenced PNG', async () => {
    const fixture = await createFixture('![CAGRA](./assets/cagra.png)', true, true);
    const result = await discoverLocalWhiteboardAssets({
      sourcePath: fixture.sourcePath,
      markdown: fixture.markdown,
      document: localSemanticDocument(fixture.markdown),
      tracked: []
    });

    expect(result.blockers).toEqual([]);
    expect(result.assets).toContainEqual(expect.objectContaining({
      assetKey: 'assets/cagra.png',
      pngPath: join(fixture.dir, 'assets', 'cagra.png'),
      svgPath: join(fixture.dir, 'assets', 'cagra.svg'),
      svgHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedTexts: ['CAGRA']
    }));
  });

  it('ignores a PNG without a sibling SVG when it is not tracked', async () => {
    const fixture = await createFixture('![CAGRA](./assets/cagra.png)', true, false);
    const result = await discoverLocalWhiteboardAssets({
      sourcePath: fixture.sourcePath,
      markdown: fixture.markdown,
      document: localSemanticDocument(fixture.markdown),
      tracked: []
    });

    expect(result).toEqual({ assets: [], blockers: [] });
  });

  it('blocks a tracked asset whose SVG disappeared', async () => {
    const fixture = await createFixture('![CAGRA](./assets/cagra.png)', true, false);
    const result = await discoverLocalWhiteboardAssets({
      sourcePath: fixture.sourcePath,
      markdown: fixture.markdown,
      document: localSemanticDocument(fixture.markdown),
      tracked: [{ assetKey: 'assets/cagra.png', svgPath: 'assets/cagra.svg' }]
    });

    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'missing-local-svg',
      assetKey: 'assets/cagra.png'
    }));
  });

  it('blocks an inline image only when its same-name SVG exists', async () => {
    const fixture = await createFixture('See ![CAGRA](./assets/cagra.png) for details.', true, true);
    const result = await discoverLocalWhiteboardAssets({
      sourcePath: fixture.sourcePath,
      markdown: fixture.markdown,
      document: localSemanticDocument(fixture.markdown),
      tracked: []
    });

    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'inline-whiteboard-unsupported',
      assetKey: 'assets/cagra.png'
    }));
  });

  it('ignores network images, data URLs, and non-PNG assets', async () => {
    const markdown = [
      '![Remote](https://example.com/diagram.png)',
      '![Inline](data:image/png;base64,AA==)',
      '![Vector](./assets/diagram.svg)'
    ].join('\n\n');
    const dir = await mkdtemp(join(tmpdir(), 'fms-assets-'));
    const sourcePath = join(dir, 'doc.md');
    await writeFile(sourcePath, markdown, 'utf8');

    const result = await discoverLocalWhiteboardAssets({
      sourcePath,
      markdown,
      document: localSemanticDocument(markdown),
      tracked: []
    });

    expect(result).toEqual({ assets: [], blockers: [] });
  });

  it('loads a tracked direct SVG under its existing PNG receipt key', async () => {
    const fixture = await createFixture('![CAGRA](./assets/cagra.svg)', false, true);
    const result = await discoverLocalWhiteboardAssets({
      sourcePath: fixture.sourcePath,
      markdown: fixture.markdown,
      document: localSemanticDocument(fixture.markdown),
      tracked: [{ assetKey: 'assets/cagra.png', svgPath: 'assets/cagra.svg' }],
      includeDirectSvg: true
    });

    expect(result.blockers).toEqual([]);
    expect(result.assets).toContainEqual(expect.objectContaining({
      assetKey: 'assets/cagra.png',
      svgKey: 'assets/cagra.svg',
      sourceKind: 'direct-svg',
      pngPath: join(fixture.dir, 'assets', 'cagra.png'),
      svgPath: join(fixture.dir, 'assets', 'cagra.svg')
    }));
  });

  it('normalizes equivalent asset keys to POSIX relative paths', () => {
    expect(normalizeAssetKey('./assets/../assets/cagra.png')).toBe('assets/cagra.png');
    expect(normalizeAssetKey('assets\\cagra.png')).toBe('assets/cagra.png');
  });
});

async function createFixture(markdown: string, withPng: boolean, withSvg: boolean): Promise<{
  dir: string;
  sourcePath: string;
  markdown: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fms-assets-'));
  const assets = join(dir, 'assets');
  const sourcePath = join(dir, 'doc.md');
  await mkdir(assets);
  await writeFile(sourcePath, markdown, 'utf8');
  if (withPng) await writeFile(join(assets, 'cagra.png'), 'png', 'utf8');
  if (withSvg) {
    await writeFile(join(assets, 'cagra.svg'), '<svg viewBox="0 0 10 10"><text x="1" y="5">CAGRA</text></svg>', 'utf8');
  }
  return { dir, sourcePath, markdown };
}
