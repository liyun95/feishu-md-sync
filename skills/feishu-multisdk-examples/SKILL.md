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

- Before running commands, tell the user that this workflow requires two confirmations: exactly one target language and the Milvus validation target.
- Ask the user for exactly one target language before initializing. Do not default to all languages.
- Ask the user which Milvus target to validate against before preparing validation. If the docs target an unreleased build, ask for the source repo and branch/tag/commit.
- Default validation runner is `manta-client`. Use local validation only when the user explicitly asks or Manta is unavailable.
- After `multisdk prepare`, fill the selected-language snippet files from `work/<language>/python-context.md`, then run `multisdk author` before validation. Do not validate empty snippets.
- Do not push to Feishu from the multi-SDK apply step. First write `outputs/review.md` locally and show the user the diff.
- Push to Feishu only through a reviewed command such as `md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf` after user approval.
- Finish with `md2feishu harness grade runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --workflow multisdk`.

## Completion

Finish only when the selected language is audited and the harness grade is `passed`, or clearly reports only user-approved incomplete work.
