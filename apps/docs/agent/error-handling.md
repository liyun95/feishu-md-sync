# Error Handling

Agents should convert CLI errors into clear next steps.

## Missing Receipt Snapshot

Meaning: merge needs a successful baseline sync first.

Response: explain the baseline requirement and ask whether to create an initial baseline.

## Initial Write Protection

Meaning: the remote document has content but no local receipt exists.

Response: do not add `--force-initial-overwrite` automatically. Ask the human whether replacing the Feishu document is intentional.

## Remote Changed

Meaning: Feishu changed since the last successful receipt.

Response: run or suggest:

```bash
npm exec -- md2feishu status ./doc.md DocToken
npm exec -- md2feishu diff ./doc.md DocToken
npm exec -- md2feishu merge ./doc.md DocToken
```

## Feishu Auth Or API Error

Meaning: credentials, permissions, network, or API behavior blocked the operation.

Response: report the exact error and avoid retrying write commands blindly.

## Verification Mismatch

Meaning: the write readback did not match the desired state.

Response: stop and report the mismatch. Do not assume the Feishu document is safe to overwrite again.
