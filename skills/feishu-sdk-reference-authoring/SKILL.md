---
name: feishu-sdk-reference-authoring
description: Use when SDK reference changes need to be planned, written, and audited on Feishu without releasing them to web-content.
---

# Feishu SDK Reference Authoring

This workflow ends at audited Feishu content. Releasing to `web-content` is a separate human-triggered workflow.

## Required Discovery

Run:

```bash
md2feishu workflow show sdk-reference-authoring --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show sdk-reference-authoring --format json
```

Follow the returned steps.

## Safety Rules

- Start with source freshness preflight.
- Do not accept a no-action plan unless source freshness evidence supports it.
- Dry-run `reference apply` before `--write`.
- Run `reference audit` after Feishu writes.
- Do not run `reference export`, `reference web-content`, or `reference release run` from this skill.

## Completion

Finish only when Feishu reference changes are written and audited. Stop before any `web-content` release work.
