# Release Checklist

Before release or sharing:

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Run `npm run docs:build`.
- Check `md2feishu --help`.
- Check `md2feishu sync --help`.
- Check `md2feishu merge --help`.
- Verify README links to the docs.
- Verify GitHub Pages deployment settings are enabled for GitHub Actions.
- Confirm `.env`, `.sync/`, `dist/`, `coverage/`, and `.superpowers/` are not committed.
