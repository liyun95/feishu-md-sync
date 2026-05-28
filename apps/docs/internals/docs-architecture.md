# Docs Architecture

The documentation has one source of workflow truth: `md2feishu workflow show <workflow-id>`.

Human-facing docs and agent-facing docs may have different entry pages, but they must not duplicate workflow command sequences, safety gates, or completion criteria. They should link to the same workflow pages and reference tables.

## Layers

| Layer | Audience | Purpose |
| --- | --- | --- |
| Quickstart | Human users | Choose the right workflow and run the first command. |
| Workflow guide | Humans and agents | Explain workflow intent, artifacts, safety gates, and completion state. |
| Command reference | Humans needing exact flags | Document command syntax, not workflow strategy. |
| Agent skills | Agents | Select workflow, enforce boundaries, and call CLI recipes. |
| Internals | Maintainers | Explain architecture, receipts, harness, Feishu API behavior, and release checks. |

## Duplication Rule

If a command sequence appears in more than one page, replace the duplicate with a link to the workflow guide or `md2feishu workflow show <workflow-id>`.

## URL Compatibility

Keep existing guide and skill URLs where possible. Old pages may remain as short entry points, but they must not become separate workflow sources.
