import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ENGINE_CAPABILITIES,
  ENGINE_SCHEMA_VERSION,
  ENGINE_VERSION,
} from '../src/index.js';

interface RootPackage {
  scripts: Record<string, string>;
}

interface EnginePackage {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as RootPackage;
const enginePackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as EnginePackage;
const engineVitestConfig = readFileSync(
  new URL('../vitest.config.ts', import.meta.url),
  'utf8',
);

describe('package contract', () => {
  it('exports stable engine identity', () => {
    expect(ENGINE_VERSION).toBe('0.1.0');
    expect(ENGINE_SCHEMA_VERSION).toBe(1);
    expect(ENGINE_CAPABILITIES).toEqual([
      'nested-list-create-v1',
      'native-table-create-v1',
      'whiteboard-overwrite-v1',
      'partial-write-evidence-v1',
    ]);
  });

  it('aggregates engine and CLI verification from root scripts', () => {
    expect(rootPackage.scripts['build:engine']).toBe(
      'npm run build --workspace=feishu-docx-engine',
    );
    expect(rootPackage.scripts['build:cli']).toBe(
      'npm run build --workspace=feishu-md-sync',
    );
    expect(rootPackage.scripts.build).toBe(
      'npm run build:engine && npm run build:cli',
    );

    expect(rootPackage.scripts['test:engine']).toBe(
      'npm run test --workspace=feishu-docx-engine',
    );
    expect(rootPackage.scripts['test:cli']).toBe(
      'npm run test --workspace=feishu-md-sync',
    );
    expect(rootPackage.scripts.test).toBe(
      'npm run test:engine && npm run test:cli',
    );

    expect(enginePackage.scripts['test:coverage']).toBe(
      'vitest run --coverage',
    );
    expect(enginePackage.devDependencies['@vitest/coverage-v8']).toBe('^3.2.4');
    expect(rootPackage.scripts['test:coverage:engine']).toBe(
      'npm run test:coverage --workspace=feishu-docx-engine',
    );
    expect(rootPackage.scripts['test:coverage:cli']).toBe(
      'npm run test:coverage --workspace=feishu-md-sync',
    );
    expect(rootPackage.scripts['test:coverage']).toBe(
      'npm run test:coverage:engine && npm run test:coverage:cli',
    );
    expect(engineVitestConfig).toContain("include: ['src/**/*.ts']");
    expect(engineVitestConfig).toContain("exclude: ['src/transport.ts']");
    expect(engineVitestConfig).toContain('lines: 80');
    expect(engineVitestConfig).toContain('functions: 80');
    expect(engineVitestConfig).toContain('branches: 75');
    expect(engineVitestConfig).toContain('statements: 80');

    expect(rootPackage.scripts['typecheck:engine']).toBe(
      'npm run typecheck --workspace=feishu-docx-engine',
    );
    expect(rootPackage.scripts['typecheck:cli']).toBe(
      'npm run typecheck --workspace=feishu-md-sync',
    );
    expect(rootPackage.scripts.typecheck).toBe(
      'npm run typecheck:engine && npm run typecheck:cli',
    );
  });
});
