# Testing

Run these commands before claiming a change is complete:

```bash
npm run typecheck
npm test
npm run build
npm run docs:build
```

## Current Test Coverage Areas

- document ID and URL parsing
- Feishu client behavior
- hashing and normalization
- Markdown conversion
- block-state comparison
- patch planning
- receipt read/write
- conflict detection
- status
- diff
- pull
- merge
- sync

## CLI Smoke Checks

```bash
node packages/cli/dist/cli/index.js --help
node packages/cli/dist/cli/index.js sync --help
node packages/cli/dist/cli/index.js merge --help
```
