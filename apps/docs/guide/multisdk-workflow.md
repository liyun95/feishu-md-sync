# Multi-SDK Examples

## Use this when

Use this workflow when a Feishu user doc has Python examples and needs verified Java, JavaScript, Go, or REST examples.

## Do not use this when

Do not use this workflow for unrelated prose edits or whole-document sync. Use it only when the task is language-scoped example completion and validation.

## Local-first workflow

Multi-SDK examples are completed one language at a time.

Before running the workflow, tell the user that two confirmations are required: the single target language and the Milvus validation target.

1. Choose one target language.
2. Confirm the Milvus validation target with the user.
3. Prepare verifier artifacts from the Python examples.
4. Author the selected-language snippets from the Python context.
5. Run the verifier against real Milvus, defaulting to `manta-client`.
6. Write the reviewed examples to local Markdown.
7. Review the local diff.
8. Push the reviewed Markdown to Feishu only after approval.

```bash
md2feishu multisdk init 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf' --out runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --language java
md2feishu multisdk environment runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --milvus-version 2.6.0
md2feishu multisdk prepare runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java
md2feishu multisdk author runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java
md2feishu multisdk validate runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --runner manta --command "mvn test"
md2feishu multisdk apply-local runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java
md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf'
md2feishu multisdk record-push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --mode dry-run --command "md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf"
md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf' --write -y
md2feishu multisdk record-push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --mode write --command "md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y"
md2feishu multisdk audit runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java
md2feishu harness grade runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --workflow multisdk
```

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- Harness tools: `md2feishu harness tools --workflow multisdk --format json`
