---
name: milvus-release-notes-workflow
description: Use when updating Milvus release notes, release Variables.json, SDK version values, or release-note user-doc links from Feishu source documents.
---

# Milvus Release Notes Workflow

Use this skill for Milvus release documentation updates that start from Feishu release-note content and need SDK version checks.

Required inputs:

- release line, such as `2.6.x` or `3.0.x`;
- release version, such as `2.6.17`;
- Feishu release-note URL;
- local Milvus docs path;
- optional user-doc mappings in `local/path.md=feishu-url` format;
- optional link map JSON.

Workflow:

1. Initialize the task with `md2feishu release init`.
2. Pull Feishu release notes with `md2feishu release pull`.
3. Scan SDK tags with `md2feishu release scan-sdk-tags`.
4. Run `md2feishu release audit`.
5. Stop and ask the user to review `report.md`.
6. After approval, run `md2feishu release approve`.
7. Run dry-run `md2feishu release apply`.
8. Stop before `md2feishu release apply --write` unless the user explicitly asks to write files.

Source-of-truth rules:

- Feishu release-note docs are source for release-note text.
- SDK repositories and tags are source for SDK version values.
- Feishu user-doc pages are source for user-guide content.
- Existing local user-doc files and anchors are required before release-note links are inserted.

Use `feishu-markdown-sync` for whole user-doc sync. Use `feishu-codeblock-writer` for Feishu code-block edits. Do not commit, push, or open PRs unless the user explicitly asks.
