# Dogfood Harness Design

Date: 2026-05-22

## Context

The first real multi-SDK dogfood workflow completed one Milvus Feishu document, but it took roughly two hours and depended heavily on chat context. The work succeeded, yet the execution state was not durable enough: SDK validation evidence, per-language progress, Feishu write status, and cleanup state were spread across terminal output, local ad hoc files, and session memory.

The V2 design introduces a lightweight repo-native harness for Feishu multi-SDK code-block work. It keeps the existing `code-blocks` primitives as the write engine and adds task-level orchestration, persistent state, and per-language execution lanes.

## Goals

- Make one Feishu document task resumable without relying on chat history.
- Split multi-SDK completion by language: Java, JavaScript, Go, and RESTful.
- Preserve canonical code-block order: Python, Java, JavaScript, Go, RESTful.
- Require dry-run before writes and readback audit after writes.
- Record validation evidence for each language before marking it write-ready.
- Generate a compact handoff summary for future sessions.

## Non-Goals

- C++ support is out of scope.
- The harness does not decide SDK feature support from official Milvus docs.
- The harness does not replace `code-blocks inspect`, `plan`, `export`, `apply`, or `audit`.
- The harness does not create or manage Manta clusters directly in V2.
- The harness does not auto-generate correct SDK examples without human or agent review.

## Command Model

Add a new CLI group:

```bash
md2feishu dogfood <command>
```

The V2 command surface is:

```bash
md2feishu dogfood init <feishu-doc> --out dogfood/<doc-token>
md2feishu dogfood status <task-dir>
md2feishu dogfood export <task-dir> --language <language>
md2feishu dogfood verify <task-dir> --language <language> --evidence <file> --command <command>
md2feishu dogfood apply <task-dir> --language <language>
md2feishu dogfood apply <task-dir> --language <language> --write -y
md2feishu dogfood audit <task-dir> --language <language>
md2feishu dogfood finalize <task-dir>
```

Supported language values are `java`, `javascript`, `go`, and `restful`. Aliases `node`, `nodejs`, and `js` normalize to `javascript`.

## Task Directory

Each document gets one task directory:

```text
dogfood/<doc-token>/
  task.json
  manifest.json
  snippets/
  validation/
  evidence/
  handoff.md
```

`dogfood/` remains an operator workspace. It is not committed by default unless the user explicitly asks to preserve a dogfood run in git.

## Task State

`task.json` is the source of truth for harness state:

```json
{
  "kind": "feishu-multisdk-dogfood-task",
  "version": 1,
  "document": "https://zilliverse.feishu.cn/wiki/example",
  "documentId": "doc-id",
  "taskDir": "dogfood/doc-id",
  "languageOrder": ["python", "java", "javascript", "go", "restful"],
  "languages": {
    "java": {
      "status": "pending",
      "sourceVerified": false,
      "snippetsReady": false,
      "validated": false,
      "dryRunPassed": false,
      "writePassed": false,
      "auditPassed": false,
      "evidence": []
    }
  },
  "finalAuditPassed": false,
  "cleanup": []
}
```

Language status values are:

- `pending`: no usable snippets yet.
- `exported`: snippet files exist for this language.
- `ready`: snippets are filled and validation evidence is attached.
- `dry-run-passed`: write plan has been checked without writing.
- `written`: Feishu write completed.
- `audited`: language readback audit passed.
- `blocked`: manual intervention is required.

## Data Flow

`dogfood init` resolves the Feishu document, inspects code blocks, creates the task directory, writes `manifest.json`, exports snippet files, and initializes per-language state.

`dogfood export --language` refreshes only that language's snippet files from the current Feishu document and updates the task state. This avoids forcing all SDK work to start at once.

`dogfood verify --language` records evidence that the language snippets were checked. V2 accepts an evidence file and the validation command string. It does not run validators itself unless a future language adapter is added.

`dogfood apply --language` creates a temporary language-scoped manifest from `manifest.json`, then delegates to existing `code-blocks apply`. Without `--write`, it performs a dry run. With `--write -y`, it writes only that language's blocks.

`dogfood audit --language` delegates to existing `code-blocks audit` with `--expect <language>` and updates the language state.

`dogfood finalize` runs a full audit for `java,javascript,go,restful`, writes `handoff.md`, and reports any incomplete language or cleanup item.

## Safety Rules

- `apply --write` fails unless the same language has already passed dry-run in the current task state.
- `apply --write` fails unless validation evidence exists for the language.
- `finalize` fails unless every language is `audited`.
- The harness writes only under the task directory and through existing Feishu write APIs.
- The harness never treats official Milvus docs as SDK source truth.
- RESTful snippets that read back as `bash` or `shell` are accepted when they contain curl REST API calls.

## Error Handling

Every command updates `task.json` only after its operation succeeds. On failure, the command prints the failed phase, language, and next suggested command. If a write succeeds but audit fails, the language status remains `written`, not `audited`, so the next session can resume with `dogfood audit`.

Blocked states include a free-text `reason` field and do not prevent other languages from proceeding.

## Testing

Unit tests should cover:

- Task initialization from a fake code-block inventory.
- Language alias normalization.
- Language-scoped manifest filtering.
- State transitions for export, verify, dry-run, write, audit, and finalize.
- Write gating when validation evidence or dry-run is missing.
- Handoff summary generation.

Integration tests should use a fake Feishu client and verify that language-scoped apply delegates only the selected SDK blocks. Live Feishu smoke testing remains manual and disposable.

## Documentation

Update the docs site with:

- A dogfood harness guide.
- Command reference for `dogfood`.
- Updated `milvus-multisdk-example-sync` skill text.
- Updated `feishu-codeblock-writer` text clarifying that it remains the low-level code-block engine.

## Rollout

Phase 1 adds the task model, status, language filtering, and handoff generation.

Phase 2 wires Feishu-backed init, export, apply, and audit commands around existing code-block primitives.

Phase 3 adds docs, skill updates, and a disposable live smoke run on one real Feishu document.
