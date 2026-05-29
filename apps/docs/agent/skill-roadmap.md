# Skill Roadmap

Each first-class workflow maps to one installable Codex skill. The CLI workflow registry remains the source of truth:

```bash
md2feishu workflow list
md2feishu workflow show <workflow-id> --format json
```

## Workflow Skills

| Workflow | Skill source |
| --- | --- |
| `baseline-sync` | `skills/feishu-baseline-sync/SKILL.md` |
| `publish-new` | `skills/feishu-publish-new/SKILL.md` |
| `push` | `skills/feishu-push/SKILL.md` |
| `multisdk-examples` | `skills/feishu-multisdk-examples/SKILL.md` |
| `sdk-reference-authoring` | `skills/feishu-sdk-reference-authoring/SKILL.md` |
| `sdk-reference-web-content-release` | `skills/feishu-sdk-reference-release/SKILL.md` |
| `release-notes` | `skills/feishu-release-notes/SKILL.md` |

Install them with:

```bash
scripts/install-codex-skills.sh
```

## Boundaries

Feishu Markdown pull must not write Feishu. Feishu push must use a dry-run strategy plan before writing and must not patch individual SDK code blocks. Code-block writes must not judge SDK correctness. SDK source verification must not write Feishu. SDK reference publishing must not scan source or infer doc impact. Milvus multi-SDK workflow composes source verification and code-block writing. Milvus release notes workflow composes the release CLI, Feishu Markdown pull/push, and SDK source verification; it must not bypass approval before local `--write`.

## Workflow Skill Pressure Scenarios

- Baseline sync: agent must not write to Feishu after pull unless the user switches workflows.
- Publish new: agent must not create a Feishu document without a dry-run and explicit destination.
- Feishu push: agent must not choose block, section, or document granularity before reviewing the dry-run strategy plan.
- Multi-SDK examples: agent must not write unverified snippets.
- SDK reference authoring: agent must stop after Feishu audit and must not export to `web-content`.
- SDK reference release: agent must require explicit human release intent before touching `web-content`.
- Release notes: agent must not apply local docs changes without approval of the current report hash.

## Follow-Ups

- Add durable receipts for code-block manifests.
- Expand reference audit coverage for table creation and post-action scripts.
- Add live Feishu smoke tests against approved disposable docs, folders, and Bases.
