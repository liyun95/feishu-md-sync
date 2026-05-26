# Agent Harness Design

Date: 2026-05-26

## Context

The harness article frames a useful minimum structure for agent work: Task, Environment, Tools, Trace, and Grader. That maps well to `feishu-md-sync` because the project has already grown from a Markdown-to-Feishu sync CLI into a set of task-oriented engineering workflows.

The current CLI already has several harness-like pieces:

- `multisdk` has task directories, per-language state, validation evidence, dry-run gates, write gates, readback audit, docs landing, and `handoff.md`.
- `release` has task directories, Feishu source snapshots, SDK tag scans, audit reports, approval hashes, dry-run apply, and gated local writes.
- `reference` has source freshness checks, explicit impact matrices, Feishu apply/audit reports, web-content export reports, and PR handoff metadata.

The gap is not a missing workflow. The gap is that each workflow records state differently, exposes environment expectations in prose, and reports pass/fail through workflow-specific artifacts. That makes it hard for a teammate or agent to answer the basic harness questions: what task was run, what environment it ran in, which tools were allowed, what actually happened, and why the result passed or failed.

## Goals

- Add a shared, repo-native harness contract around existing CLI workflows.
- Make Task, Environment, Tools, Trace, and Grader explicit CLI concepts.
- Start with `multisdk` because it is closest to a complete harness today.
- Keep existing `multisdk`, `release`, and `reference` command surfaces working.
- Produce durable artifacts that teammates can inspect without reading chat history.
- Give agents a deterministic tool menu instead of relying on ad hoc shell plans.
- Give reviewers a single grade artifact that explains pass/fail from evidence.

## Non-Goals

- Do not build a general agent runtime or model orchestration layer.
- Do not replace existing `multisdk`, `release`, `reference`, `sync`, or `code-blocks` commands.
- Do not run LLM evaluation in V1.
- Do not automatically decide SDK feature support from generated prose.
- Do not create a hosted dashboard.
- Do not make live Feishu smoke tests mandatory for normal unit test runs.

## Harness Model

The shared model has five parts.

### Task

A task is the durable input and state for one workflow run. Existing task files stay as the source of truth:

- `runs/<doc-token>/task.json` for `multisdk`.
- `runs/releases/<version>/task.json` for `release`.
- A reference release config plus manifest/report paths for `reference`.

V1 adds a normalized task summary shape used by graders and status output:

```json
{
  "workflow": "multisdk",
  "taskDir": "runs/doc-token",
  "taskKind": "feishu-multisdk-task",
  "taskVersion": 1,
  "status": "in-progress",
  "subject": {
    "document": "https://zilliverse.feishu.cn/wiki/example",
    "documentId": "doc-id"
  }
}
```

The normalized summary is derived from existing task state. It is not a second source of truth.

### Environment

The environment is the set of local and remote conditions required to run a workflow. V1 makes it machine-readable with:

```bash
md2feishu harness env --format json
```

The command reports:

- Node version and npm version.
- CLI package name and version.
- Current working directory.
- Feishu host.
- Whether `APP_ID` and `APP_SECRET` are present, without printing secrets.
- Whether the explicit or discovered `.env` file was loaded.
- Available validation profiles, such as `manta-k8s-maven` and `local-node`.
- Optional workflow-specific paths passed by flag, such as `--milvus-docs`, `--web-content-repo`, or `--sdk-repo`.

Example output:

```json
{
  "kind": "feishu-harness-environment",
  "version": 1,
  "generatedAt": "2026-05-26T00:00:00.000Z",
  "node": "v20.19.0",
  "npm": "10.8.2",
  "cli": {
    "name": "feishu-md-sync",
    "version": "0.1.0"
  },
  "feishu": {
    "host": "https://open.feishu.cn",
    "appIdPresent": true,
    "appSecretPresent": true
  },
  "validationProfiles": [
    {
      "id": "manta-k8s-maven",
      "language": "java",
      "containerImage": "maven:3.9-eclipse-temurin-17"
    }
  ]
}
```

For task workflows, commands that initialize or grade a task also write `environment.json` under the task directory. This lets a teammate inspect the environment used for a run after the session ends.

### Tools

Tools are the CLI operations an agent is allowed to use for a workflow. V1 exposes them with:

```bash
md2feishu harness tools --workflow multisdk --format json
```

For `multisdk`, the allowed tool surface is:

- `multisdk init`
- `multisdk status`
- `multisdk export`
- `multisdk profile`
- `multisdk verify`
- `multisdk diff`
- `multisdk apply`
- `multisdk audit`
- `multisdk land-docs`
- `multisdk finalize`
- read-only supporting tools: `doctor auth`, `code-blocks inspect`, `code-blocks audit`, `pull`

Each tool entry includes:

- command name;
- read/write mode;
- required inputs;
- produced artifacts;
- safety gates;
- whether it can touch Feishu, local files, external repos, or only task state.

Example:

```json
{
  "name": "multisdk apply",
  "mode": "dry-run-or-write",
  "writesFeishu": true,
  "requires": ["taskDir", "language"],
  "writeRequires": ["--write", "validation evidence", "fresh dry-run"],
  "artifacts": ["task.json", "trace/events.jsonl"]
}
```

The tools registry is documentation and machine-readable guidance. It does not prevent a human from running other CLI commands, but agent skills should treat the registry as the allowed tool menu.

### Trace

Trace records what happened during the task. V1 writes append-only JSONL events to:

```text
runs/<task>/trace/events.jsonl
```

Every task-level command records one event after the command completes. Commands that fail still write a failure event when the task directory can be resolved.

Event shape:

```json
{
  "kind": "feishu-harness-trace-event",
  "version": 1,
  "eventId": "01J...",
  "workflow": "multisdk",
  "taskDir": "runs/doc-token",
  "tool": "multisdk.verify",
  "mode": "record-evidence",
  "startedAt": "2026-05-26T00:00:00.000Z",
  "endedAt": "2026-05-26T00:00:02.000Z",
  "durationMs": 2000,
  "status": "passed",
  "arguments": {
    "language": "java",
    "profile": "manta-k8s-maven"
  },
  "artifacts": [
    {
      "path": "evidence/java-1779800000000-mvn.log",
      "sha256": "sha256:..."
    }
  ],
  "summary": "Recorded java validation evidence."
}
```

Trace rules:

- Do not write secrets.
- Store relative paths when the path is inside the task directory.
- Hash artifact content when practical.
- Capture command mode, not raw shell history.
- Append events only after the operation has a known outcome.
- Preserve existing task-state semantics; trace is not the source of truth for workflow state.

### Grader

The grader reads task state and artifacts, then emits one reviewable result:

```bash
md2feishu harness grade runs/<task-dir> --workflow multisdk --format json
```

It writes:

```text
runs/<task>/grade.json
runs/<task>/grade.md
```

For `multisdk`, the grader checks:

- `task.json` is a valid `feishu-multisdk-task`.
- Every target language is either complete or explicitly reported as incomplete.
- Completed languages have exported snippets.
- Completed languages have validation evidence.
- Completed languages passed dry-run before write.
- Completed languages passed write if they are marked written.
- Completed languages passed readback audit.
- `finalAuditPassed` is true only when all lanes are audited and full audit passed.
- `handoff.md` exists when final audit passed.
- Trace exists and includes the expected major phases for completed lanes.

The grader returns `passed`, `blocked`, or `incomplete`:

- `passed`: all workflow done-definition checks pass.
- `blocked`: a required safety or audit check failed.
- `incomplete`: the task is valid but still in progress.

Example:

```json
{
  "kind": "feishu-harness-grade",
  "version": 1,
  "workflow": "multisdk",
  "taskDir": "runs/doc-token",
  "result": "incomplete",
  "checks": [
    {
      "id": "java-evidence",
      "passed": true,
      "message": "java has validation evidence."
    },
    {
      "id": "go-audit",
      "passed": false,
      "severity": "incomplete",
      "message": "go has not passed readback audit."
    }
  ],
  "nextCommands": [
    "md2feishu multisdk audit runs/doc-token --language go"
  ]
}
```

The grader should be deterministic and rule-based. It should not call an LLM.

## Command Model

Add a new CLI group:

```bash
md2feishu harness <command>
```

V1 commands:

```bash
md2feishu harness env --format json
md2feishu harness tools --workflow multisdk --format json
md2feishu harness grade <task-dir> --workflow multisdk --format json
```

`--workflow` initially supports only `multisdk`. The command accepts the option explicitly so the contract can extend to `release` and `reference` without changing the top-level shape.

## Task Directory After V1

A `multisdk` task directory becomes:

```text
runs/<doc-token>/
  task.json
  manifest.json
  snippets/
  validation/
  evidence/
    evidence.json
    evidence.md
  trace/
    events.jsonl
  environment.json
  grade.json
  grade.md
  handoff.md
```

`environment.json`, `trace/events.jsonl`, `grade.json`, and `grade.md` are harness artifacts. They are local run artifacts and remain under ignored `runs/` unless the user explicitly shares a run.

## Data Flow

`harness env` reads the local environment and prints a report. When called with task-related path flags, it includes those path checks in the report.

`harness tools --workflow multisdk` prints the machine-readable tool registry for the multi-SDK workflow.

`multisdk init` writes the initial `task.json`, `manifest.json`, snippets, `environment.json`, and a trace event.

`multisdk export`, `verify`, `diff`, `apply`, `audit`, `land-docs`, and `finalize` append trace events after each command completes.

`harness grade <task-dir> --workflow multisdk` refreshes `environment.json`, then reads `task.json`, `evidence/evidence.json`, `trace/events.jsonl`, and `handoff.md` when present. It writes `grade.json` and `grade.md`, then exits non-zero only for `blocked`. An `incomplete` task is a valid in-progress state and prints next commands.

## Error Handling

Harness artifact failures should not hide the primary workflow error. If a `multisdk` operation fails and trace writing also fails, the command reports the workflow error first and includes a secondary trace warning.

`harness grade` should distinguish malformed task state from incomplete work:

- Malformed or unsupported task state is `blocked`.
- Missing evidence for a completed write is `blocked`.
- A language that has not started is `incomplete`.
- A missing trace file is `incomplete` for legacy tasks unless task state claims final completion.
- A missing trace file is `blocked` when `finalAuditPassed` is true, because final completion should be traceable after V1.

## Safety Rules

- Harness commands never print `APP_SECRET`.
- Trace arguments redact known secret-like keys.
- `harness grade` never writes Feishu or external repositories.
- `harness env` performs local inspection only.
- `harness tools` is static metadata.
- Existing write gates remain in the workflow modules.
- V1 does not loosen any `multisdk apply --write` requirement.

## Testing

Unit tests should cover:

- Environment report generation with injected Node/npm/package/auth inputs.
- Tools registry output for `multisdk`.
- Trace event serialization, artifact hashing, and secret redaction.
- Grading valid pending, incomplete, blocked, and passed `multisdk` tasks.
- Grader next-command suggestions.
- Legacy `multisdk` task grading when no trace file exists.

Integration-style tests should use temporary task directories and fake task/evidence files. Live Feishu is not required.

Existing workflow tests should continue to pass without requiring harness artifacts from old fixtures.

## Documentation

Update docs with:

- A harness overview page explaining Task, Environment, Tools, Trace, and Grader.
- Command reference entries for `harness env`, `harness tools`, and `harness grade`.
- Multi-SDK workflow docs showing the new artifacts and final grade command.
- Agent skill text telling agents to inspect `harness tools` before running a workflow and to finish with `harness grade`.

## Rollout

Phase 1 adds shared harness modules and `harness env/tools/grade` for `multisdk`.

Phase 2 instruments `multisdk` task-level commands to write trace and environment artifacts.

Phase 3 updates docs and agent skill pages.

Phase 4 extends the same contract to `release`.

Phase 5 extends the same contract to `reference`.

## Design Decisions

- `harness grade` exits zero for `passed` and `incomplete`, and non-zero for `blocked`.
- `multisdk` remains the first workflow because it has the clearest per-lane done definition.
- `release` and `reference` are explicitly deferred so V1 can prove the contract before broadening it.
