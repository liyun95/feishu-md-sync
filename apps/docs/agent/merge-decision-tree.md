# Merge Decision Tree

Agents should follow this sequence.

## 1. Inspect Status

```bash
npm exec -- md2feishu status ./doc.md DocToken
```

## 2. If Remote Did Not Change

Run a dry-run or authorized write:

```bash
npm exec -- md2feishu sync ./doc.md DocToken
npm exec -- md2feishu sync ./doc.md DocToken --write --yes
```

## 3. If Remote Changed

Generate a merged file:

```bash
npm exec -- md2feishu merge ./doc.md DocToken
```

## 4. If Merge Is Clean

Publish the merged file:

```bash
npm exec -- md2feishu sync ./doc.merged.md DocToken --write --yes --strategy local-wins
```

or run automated merge sync when the human authorized it:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

## 5. If Merge Has Conflicts

Report the `.merged.md` path and stop.

Do not publish a file that still contains:

```text
<<<<<<< LOCAL
||||||| BASE
=======
>>>>>>> FEISHU
```
