# Release Workflow

Use `release` for Milvus release notes work that needs Feishu source text, SDK version checks, Variables audit, user-doc link checks, and a gated local apply.

Initialize a task:

```bash
md2feishu release init \
  --release-line 2.6.x \
  --version 2.6.17 \
  --release-doc "$RELEASE_DOC" \
  --milvus-docs ~/milvus-docs \
  --out runs/releases/2.6.17
```

Run the read-only phases:

```bash
md2feishu release pull runs/releases/2.6.17
md2feishu release scan-sdk-tags runs/releases/2.6.17
md2feishu release audit runs/releases/2.6.17
```

Review `runs/releases/2.6.17/report.md`. If the report is correct:

```bash
md2feishu release approve runs/releases/2.6.17 --by "$USER"
md2feishu release apply runs/releases/2.6.17
md2feishu release apply runs/releases/2.6.17 --write
```

`apply` defaults to dry-run. `apply --write` updates only local Milvus docs files and requires approval of the current report hash.
