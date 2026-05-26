---
name: milvus-multisdk-example-sync
description: Use when a Milvus user-guide Feishu document has Python examples and needs verified Java, JavaScript, Go, or RESTful examples completed by language.
---

# Milvus Multi-SDK Example Sync

Use this skill as the main workflow for Milvus user-guide multi-SDK example completion. It is a by-language workflow: use Python examples as the behavioral baseline, verify SDK support from source, then complete Java, JavaScript, Go, and RESTful lanes with evidence. C++ is out of V1 scope.

This is different from `feishu-codeblock-writer`: this skill decides the per-language workflow, requires SDK source verification, records validation evidence, and advances one language lane at a time. `feishu-codeblock-writer` is only the lower-level tool for direct code-block operations.

Workflow:

1. Accept one Feishu document URL.
2. Initialize a resumable task with `md2feishu multisdk init "$DOC" --out runs/<doc-token>`.
3. Inspect the harness tool menu with `md2feishu harness tools --workflow multisdk --format json`.
4. Use Python snippets as the behavioral baseline.
5. Use `sdk-source-verifier` to confirm SDK support from source.
6. Complete one lane at a time with `multisdk export`, profile-guided local or Manta validation, `multisdk verify`, `multisdk diff`, dry-run `multisdk apply`, write `multisdk apply --write -y`, and `multisdk audit`.
7. When reviewed Feishu content should land in a downstream docs repo, run `multisdk land-docs` first as a dry-run, then with `--write`.
8. Repeat for Java, JavaScript, RESTful, and Go, then run `md2feishu multisdk finalize <task-dir>`.
9. Run `md2feishu harness grade <task-dir> --workflow multisdk --format json` and review `grade.md` before handoff.

Canonical order is `python > java > javascript > go > restful`. Preserve placeholders for languages that are expected by the document but not yet implemented. Prefer `javascript` externally; accept `node`, `nodejs`, and `js` as aliases.

Placeholder exception: if a release note or user-facing task advertises support for a language/API, that language cannot remain a placeholder in the linked user doc. Complete and verify the example, or remove the advertised tab/support claim before publishing.

Boundaries:

- Do not add languages that are absent from the source document unless the user asks for placeholders or completion.
- Do not treat published docs as SDK source truth; use `sdk-source-verifier`.
- Do not use whole-document sync unless the task explicitly asks to publish an entire Markdown file.
- For Java validation, prefer `md2feishu multisdk profile --language java` and record `--profile manta-k8s-maven` when using a Maven/JDK container.
- When recording verification, include source evidence such as `--sdk-version`, `--source-commit`, and `--endpoint` when available so `evidence/evidence.json` and `evidence/evidence.md` are useful for handoff.
- For downstream docs landing, pass `--base upstream/<branch>` and avoid writing on a branch whose name matches the base branch.
- Treat `trace/events.jsonl`, `grade.json`, and `grade.md` as the durable record of what the agent did and why the task passed, blocked, or remains incomplete.

Use `feishu-codeblock-writer` only when the user explicitly asks for direct code-block manipulation and resumable by-language state is unnecessary.
