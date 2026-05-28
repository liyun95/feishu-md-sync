---
layout: home

hero:
  name: md2feishu
  text: Feishu docs workflows for Codex and CLI
  tagline: Pull, edit, review, and publish Feishu documentation with workflow skills first and safe CLI commands underneath.
  actions:
    - theme: brand
      text: Start with Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Choose a Workflow
      link: /guide/workflows
    - theme: alt
      text: Command Reference
      link: /reference/commands

features:
  - title: Skill-first workflow
    details: Install Codex workflow skills and ask the agent to run the task by name.
  - title: Safe by default
    details: Write operations use dry-runs, receipts, explicit approvals, and readback checks.
  - title: Human release boundary
    details: SDK reference authoring ends in Feishu; publishing to web-content starts only after a human release request.
---

## Choose by task

| I want to... | Start with |
| --- | --- |
| Pull a Feishu doc into local Markdown before editing | [Baseline Sync](/guide/baseline-sync) |
| Update one reviewed section without rewriting the whole doc | [Reviewed Section Sync](/guide/section-sync) |
| Complete Java, JavaScript, Go, or REST examples from a Python source example | [Multi-SDK Examples](/guide/multisdk-workflow) |
| Write and audit SDK reference changes in Feishu | [SDK Reference Authoring](/guide/sdk-reference-workflow) |
| Release audited SDK reference content into `web-content` | [SDK Reference Release](/guide/sdk-reference-release-workflow) |
| Audit and apply release-note updates | [Release Notes](/guide/release-workflow) |

## Recommended path

Install the workflow skills, then ask Codex to use the skill that matches the task:

```bash
npm install
npm run build
scripts/install-codex-skills.sh
```

The skills load workflow recipes from the CLI. You can still use the CLI directly when you need exact command control or automation.

## Safety model

- Commands plan before writing unless a workflow explicitly reaches an approved write step.
- Feishu writes require `--write` and confirmation or `--yes`.
- Receipts and readback checks protect against accidental remote overwrites.
- Release workflows that touch external docs repositories require explicit human release intent.
