# Multi-SDK Workflow

Use `multisdk` when a Feishu document already has Python examples and needs verified Java, JavaScript, Go, or RESTful code blocks.

Initialize once:

```bash
md2feishu multisdk init "$DOC" --out runs/<doc-token>
```

Inspect the harness tool menu before starting agentic work:

```bash
md2feishu harness tools --workflow multisdk --format json
```

Complete one SDK lane at a time:

```bash
md2feishu multisdk export runs/<doc-token> --language java
md2feishu multisdk profile --language java
md2feishu multisdk verify runs/<doc-token> --language java --evidence runs/<doc-token>/evidence/java.log --command "mvn test" --profile manta-k8s-maven --sdk-version "milvus-sdk-java 3.0.1" --source-commit c7adc475
md2feishu multisdk diff runs/<doc-token> --language java
md2feishu multisdk apply runs/<doc-token> --language java
md2feishu multisdk apply runs/<doc-token> --language java --write -y
md2feishu multisdk audit runs/<doc-token> --language java
md2feishu multisdk land-docs runs/<doc-token> --language java --repo ~/milvus-docs --target site/en/userGuide/schema/nullable-and-default.md --base upstream/v3.0.x
md2feishu multisdk land-docs runs/<doc-token> --language java --repo ~/milvus-docs --target site/en/userGuide/schema/nullable-and-default.md --base upstream/v3.0.x --write
```

Repeat the lane workflow for `javascript`, `go`, and `restful`, then finalize:

```bash
md2feishu multisdk finalize runs/<doc-token>
```

Grade the task before handoff:

```bash
md2feishu harness grade runs/<doc-token> --workflow multisdk --format json
```

Review `grade.md`, `handoff.md`, and `trace/events.jsonl` together. `grade` returning `incomplete` is acceptable while a task is still in progress; `blocked` requires fixing the reported safety or audit failure.

The final command runs a full readback audit and writes `handoff.md` in the task directory.

## Safety

- Verify SDK support from SDK source repositories, not published Milvus docs.
- Run validation before recording evidence.
- For Java, prefer the `manta-k8s-maven` profile with `maven:3.9-eclipse-temurin-17` when Manta's default sandbox lacks `java` or `mvn`.
- `multisdk verify` writes `evidence/evidence.json` and `evidence/evidence.md`; include SDK version, source commit, and endpoint when known.
- Run `multisdk diff` before approval when reviewers need block-level old/new previews.
- Run dry-run before every real write.
- Audit after every write.
- After audit, use `multisdk land-docs` to patch only the reviewed language blocks into the downstream docs repo. Review the dry-run diff before `--write`.
- Pass `--base upstream/<branch>` so the command can reject base-named branches such as `v3.0.x` and print a clean topic-branch plan.
- Keep `runs/` local unless a run artifact is intentionally shared.
