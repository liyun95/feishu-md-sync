# feishu-docx-engine

`feishu-docx-engine` provides verified Feishu Docx snapshots, mutations, and recovery through the official `lark-cli` transport.

Its public engine surface consists of four operations:

- `snapshot` reads and normalizes the current Docx block tree.
- `prepare` compiles typed mutation intents into a deterministic physical batch.
- `apply` executes a prepared batch with preflight checks and readback verification.
- `assessRecovery` inspects interrupted batches without changing the remote document.

The initial capability contract is:

- `nested-list-create-v1`
- `native-table-create-v1`
- `whiteboard-overwrite-v1`
- `partial-write-evidence-v1`

Product-level approvals, state machines, and receipts remain owned by the calling application. The engine returns execution evidence but never advances a caller's business baseline.
