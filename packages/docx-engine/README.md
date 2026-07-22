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

## Ownership boundary

The engine owns physical Docx behavior:

- resolve Docx and Wiki selectors through the official `lark-cli` transport;
- read one revision-pinned block tree and normalize it into an immutable snapshot;
- encode typed paragraphs, headings, lists, Code blocks, Callouts, tables, and Whiteboards;
- prepare and integrity-check deterministic mutation batches;
- execute replace, insert, child-create, move, delete, table, and Whiteboard operations;
- verify readback and return structured partial-mutation and recovery evidence.

Calling products own intent and policy. They choose what content should change, translate source formats into typed desired nodes, require approvals, persist receipts or baselines, and decide how recovery evidence affects their state machine. The engine intentionally has no Markdown parser, product confirmation flags, Base registry, or product receipt format.

## Compatibility

The `0.1.x` engine API is the compatibility line for callers declaring `feishu-docx-engine >=0.1.0 <0.2.0`. Published applications may pin one exact patch version for a reproducible execution graph; the `feishu-md-sync` 0.6.x line pins `0.1.0` exactly. Engine and application packages are released independently.

Node.js 20 or newer and the official `lark-cli` are required at runtime. Import runtime and type contracts from the package root; internal `dist` modules are not public entrypoints.
