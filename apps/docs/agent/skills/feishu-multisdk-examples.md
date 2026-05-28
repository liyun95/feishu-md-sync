---
name: feishu-multisdk-examples
description: Use when completing Java, JavaScript, Go, or REST examples in a Feishu doc based on existing Python examples
---

# Feishu Multi-SDK Examples

## Required Discovery

Run:

```bash
md2feishu workflow show multisdk-examples --format json
md2feishu harness tools --workflow multisdk --format json
```

Use the workflow steps and harness tool registry as the allowed command menu.

## Safety Rules

- Work inside the task directory created by `multisdk init`.
- Do not write snippets to Feishu until verification evidence is recorded.
- Run dry-run apply before `--write`.
- Run readback audit after write.
- Finish with `md2feishu harness grade <task-dir> --workflow multisdk`.

## Completion

The workflow is complete when the target language lanes are audited and the harness grade is `passed` or clearly reports only user-approved incomplete lanes.
