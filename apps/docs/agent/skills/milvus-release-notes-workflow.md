---
name: milvus-release-notes-workflow
description: Use when Milvus release notes, Variables.json, SDK version values, or release-note user-doc links need updating from Feishu source documents.
---

# Milvus Release Notes Workflow

Use this skill for Milvus release documentation updates that start from Feishu release-note content and need SDK version checks, Variables updates, or release-note links to newly updated user docs.

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
- SDK repositories and tags are source for SDK version values, including release-line tag scans such as `2.6.x` and `3.0.x`.
- Feishu user-doc pages are source for user-guide content.
- Existing local user-doc files and anchors are required before release-note links are inserted.

Apply rules:

- Report blocked means `release apply --write` must not run.
- Dry-run apply must be reviewed before writes.
- Existing release sections are merged conservatively; local release dates, SDK tables, and user-doc links should be preserved.
- If release notes mention a newly documented feature, add or verify the user-doc link target before approval.
- If a release-note item advertises SDK/API support for a linked user doc, add `requiredLanguages` to the link map; placeholders for advertised JavaScript/Go/REST examples must block approval.

Use `feishu-markdown-pull` for user-doc content pulled from Feishu. Use `feishu-markdown-push` only when publishing a local Markdown file back to Feishu. Use `feishu-codeblock-writer` for direct Feishu code-block edits. Do not commit, push, or open PRs unless the user explicitly asks.
