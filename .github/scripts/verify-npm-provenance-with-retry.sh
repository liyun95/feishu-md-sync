#!/usr/bin/env bash

set -u

: "${EXPECTED_CERTIFICATE_IDENTITY:?Missing EXPECTED_CERTIFICATE_IDENTITY}"
: "${SIGSTORE_BUNDLE_PATH:?Missing SIGSTORE_BUNDLE_PATH}"

max_wait_seconds="${NPM_PROVENANCE_MAX_WAIT_SECONDS:-300}"
retry_delay_seconds="${NPM_PROVENANCE_RETRY_DELAY_SECONDS:-5}"

case "$max_wait_seconds" in
  ''|*[!0-9]*) echo "NPM_PROVENANCE_MAX_WAIT_SECONDS must be a positive integer." >&2; exit 1 ;;
esac
case "$retry_delay_seconds" in
  ''|*[!0-9]*) echo "NPM_PROVENANCE_RETRY_DELAY_SECONDS must be a positive integer." >&2; exit 1 ;;
esac
if (( max_wait_seconds <= 0 || retry_delay_seconds <= 0 )); then
  echo "npm provenance retry settings must be positive integers." >&2
  exit 1
fi

certificate_identity_pattern="$(node -e 'process.stdout.write("^" + process.env.EXPECTED_CERTIFICATE_IDENTITY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")')"
deadline=$((SECONDS + max_wait_seconds))

while true; do
  if node .github/scripts/download-npm-provenance.mjs \
    && sigstore verify "$SIGSTORE_BUNDLE_PATH" \
      --certificate-identity-uri "$certificate_identity_pattern" \
      --certificate-issuer 'https://token.actions.githubusercontent.com' \
    && node .github/scripts/verify-npm-provenance.mjs; then
    exit 0
  fi

  remaining_seconds=$((deadline - SECONDS))
  if (( remaining_seconds <= 0 )); then
    break
  fi
  if (( remaining_seconds < retry_delay_seconds )); then
    sleep "$remaining_seconds"
  else
    sleep "$retry_delay_seconds"
  fi
done

echo "npm provenance did not become available and valid within ${max_wait_seconds} seconds." >&2
exit 1
