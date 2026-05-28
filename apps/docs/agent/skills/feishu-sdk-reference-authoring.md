---
name: feishu-sdk-reference-authoring
description: Use when SDK reference changes need to be planned, written, and audited on Feishu without releasing to web-content
---

# Feishu SDK Reference Authoring

## Required Discovery

Run:

```bash
md2feishu workflow show sdk-reference-authoring --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Start with source freshness preflight.
- Do not accept a no-action plan unless source freshness evidence supports it.
- Dry-run `reference apply` before `--write`.
- Run `reference audit` after Feishu writes.
- Do not run `reference export`, `reference web-content`, or `reference release run` in this skill.

## Completion

The workflow is complete when Feishu reference changes are written and audited. Releasing to `web-content` is a separate human-triggered workflow.
