---
name: feishu-multisdk-examples
description: Use when Java, JavaScript, Go, or REST examples in a Feishu doc need to be completed from existing Python examples.
---

# Feishu Multi-SDK Examples

Use the workflow and harness registries as the allowed command menu. Do not invent one-off code-block operations unless the user explicitly asks for low-level block editing.

## Required Discovery

Run:

```bash
md2feishu workflow show multisdk-examples --format json
md2feishu harness tools --workflow multisdk --format json
```

If `md2feishu` is not linked globally, run the equivalent commands with `npm exec -- md2feishu`.

Follow the returned workflow steps and harness tools.

## Safety Rules

- Work inside the task directory created by `multisdk init`.
- Do not write snippets to Feishu until verification evidence is recorded.
- Run dry-run apply before `--write`.
- Run readback audit after writing.
- Finish with `md2feishu harness grade <task-dir> --workflow multisdk`.

## Completion

Finish only when the target language lanes are audited and the harness grade is `passed`, or clearly reports only user-approved incomplete lanes.
