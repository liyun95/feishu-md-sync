# Agent Harness

The harness layer makes agent work inspectable. It does not replace the existing workflow commands. It adds a shared contract for task input, environment, tools, trace, and grading.

## Model

- Task: durable workflow state, such as `runs/<doc-token>/task.json`.
- Environment: local runtime and credential presence, written as `environment.json`.
- Tools: the workflow command menu agents should use.
- Trace: append-only command events under `trace/events.jsonl`.
- Grader: deterministic pass, blocked, or incomplete output in `grade.json` and `grade.md`.

## Commands

Inspect the local environment:

```bash
md2feishu harness env --format json
```

Inspect the allowed multi-SDK tool surface:

```bash
md2feishu harness tools --workflow multisdk --format json
```

Grade a multi-SDK task:

```bash
md2feishu harness grade runs/<doc-token> --workflow multisdk --format json
```

`harness grade` exits non-zero only when the task is blocked. An incomplete task is a valid in-progress state and includes suggested next commands.

## Multi-SDK Artifacts

A harnessed multi-SDK task contains:

```text
runs/<doc-token>/
  task.json
  manifest.json
  snippets/
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

Keep `runs/` local unless a maintainer intentionally shares a run artifact.
