# Multi-SDK Workflow

Use `multisdk` when a Feishu document already has Python examples and needs verified Java, JavaScript, Go, or RESTful code blocks.

Initialize once:

```bash
md2feishu multisdk init "$DOC" --out runs/<doc-token>
```

Complete one SDK lane at a time:

```bash
md2feishu multisdk export runs/<doc-token> --language java
md2feishu multisdk verify runs/<doc-token> --language java --evidence runs/<doc-token>/evidence/java.log --command "mvn test"
md2feishu multisdk apply runs/<doc-token> --language java
md2feishu multisdk apply runs/<doc-token> --language java --write -y
md2feishu multisdk audit runs/<doc-token> --language java
```

Repeat the lane workflow for `javascript`, `go`, and `restful`, then finalize:

```bash
md2feishu multisdk finalize runs/<doc-token>
```

The final command runs a full readback audit and writes `handoff.md` in the task directory.

## Safety

- Verify SDK support from SDK source repositories, not published Milvus docs.
- Run validation before recording evidence.
- Run dry-run before every real write.
- Audit after every write.
- Keep `runs/` local unless a run artifact is intentionally shared.
