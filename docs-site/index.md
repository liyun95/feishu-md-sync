---
layout: home

hero:
  name: md2feishu
  text: Safe Markdown to Feishu sync
  tagline: Sync local Markdown to Feishu without overwriting remote edits by accident.
  actions:
    - theme: brand
      text: Start with Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Agent Guide
      link: /agent/install
    - theme: alt
      text: Command Reference
      link: /reference/commands

features:
  - title: Dry-run first
    details: The CLI defaults to planning changes. Feishu writes require explicit write flags.
  - title: Receipt-backed safety
    details: Successful writes store local and Feishu snapshots so later syncs can detect remote edits.
  - title: Conflict-aware workflow
    details: Use status, diff, pull, and merge to inspect remote changes before writing.
  - title: Agent-ready commands
    details: Non-interactive command patterns and safety rules are documented for agents and automation.
---

## How It Works

1. Configure Feishu credentials.
2. Run a dry-run against a document token or URL.
3. Create a baseline receipt with an explicit write.
4. Use `status`, `diff`, or `merge` when Feishu changed.
5. Publish clean merges or resolved `.merged.md` files.

## Current Capabilities

- Sync one local Markdown file to one existing Feishu docx document.
- Resolve docx tokens, docx URLs, and wiki URLs.
- Refuse writes by default when Feishu changed since the last receipt.
- Export Feishu content as best-effort Markdown.
- Generate a `.merged.md` file for local + Feishu edits.
- Let agents use deterministic non-interactive commands with clear stop conditions.
