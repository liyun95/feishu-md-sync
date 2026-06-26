# feishu-publish-new

Installable skill source: `skills/feishu-publish-new/SKILL.md`.

Use this skill when local Markdown has no existing Feishu target and needs first publication. The skill starts with the `publish-new` workflow recipe:

```bash
md2feishu workflow show publish-new --format json
```

After successful publication, later updates should use `feishu-push`.

If later updates include important tables or local images/SVGs, use `feishu-push` and its docs v2 overwrite backend rules rather than changing the first-publication workflow.
