# Repository Guidelines

## Project Structure & Module Organization

This is a Node 20+ TypeScript ESM npm workspaces repo for the `md2feishu` / `feishu-md-sync` CLI and its documentation site.

- `packages/cli/` contains the published CLI package.
- `packages/cli/src/cli/` contains the Commander CLI entrypoint.
- `packages/cli/src/core/` holds shared utilities such as document ID parsing and hashing.
- `packages/cli/src/feishu/` contains API client, auth token handling, and API types.
- `packages/cli/src/markdown/` converts between Markdown and Feishu block shapes.
- `packages/cli/src/sync/` implements sync, diff, status, patch, merge, pull, and conflict logic.
- `packages/cli/src/receipts/` manages local receipt state under `.sync/feishu/`.
- `packages/cli/test/` contains Vitest tests matching source areas, such as `diff.test.ts`.
- `apps/docs/` is the VitePress documentation site.
- `packages/cli/dist/`, `packages/cli/coverage/`, and `apps/docs/.vitepress/` outputs are generated; do not edit them directly.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run dev -- <args>`: run the CLI through `tsx`, for example `npm run dev -- status ./doc.md DocToken`.
- `npm run build`: compile TypeScript declarations and JavaScript into `packages/cli/dist/`.
- `npm test`: run the full Vitest suite once.
- `npm run test:coverage`: run tests with V8 coverage.
- `npm run typecheck`: run strict TypeScript checking without emitting files.
- `npm run docs:dev`: start the VitePress docs server.
- `npm run docs:build`: verify the documentation site builds.

## Coding Style & Naming Conventions

Use TypeScript with strict mode and NodeNext module resolution. Source files use two-space indentation, single quotes, semicolons, named exports, and explicit `.js` extensions in relative imports. Keep module names lowercase and hyphenated, for example `run-sync.ts`. Prefer pure helpers in `src/core/`, sync orchestration in `src/sync/`, and Feishu-specific behavior in `src/feishu/`.

## Testing Guidelines

Tests use Vitest and live in `packages/cli/test/*.test.ts`. Name test files after the behavior they cover, and group cases with `describe()` plus focused `it()` statements. Coverage is enforced for `packages/cli/src/**/*.ts` at 80% lines/functions/statements and 75% branches, excluding the CLI and Feishu type definitions. Run `npm test` for normal changes and `npm run test:coverage` before larger refactors.

## Commit & Pull Request Guidelines

The current history only contains an initial commit, so no strict convention is established. Use short imperative subjects such as `Add merge conflict tests` or `Document receipt behavior`. Pull requests should include a concise summary, linked issue if applicable, test commands run, and screenshots only for `apps/docs/` visual changes.

## Security & Configuration Tips

Real Feishu calls require `APP_ID`, `APP_SECRET`, and optionally `FEISHU_HOST`. Do not commit credentials, generated receipts under `.sync/feishu/`, local `dogfood/` outputs, coverage, or build artifacts unless intentionally updating release output.
