#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill_root="${CODEX_HOME:-"$HOME/.codex"}/skills"
remove_legacy=0

for arg in "$@"; do
  case "$arg" in
    --remove-legacy)
      remove_legacy=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/install-codex-skills.sh [--remove-legacy]

Install the Feishu workflow Codex skills from this repository into:
  ${CODEX_HOME:-$HOME/.codex}/skills

Options:
  --remove-legacy   Migration only: delete older local alias skills after installing workflow skills.

The installer always removes renamed workflow skill aliases that would otherwise duplicate a current skill.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

workflow_skills=(
  feishu-baseline-sync
  feishu-section-sync
  feishu-multisdk-examples
  feishu-sdk-reference-authoring
  feishu-sdk-reference-release
  feishu-release-notes
)

renamed_skills=(
  feishu-reviewed-section-sync
)

legacy_skills=(
  feishu-codeblock-writer
  feishu-markdown-pull
  feishu-markdown-push
  milvus-multisdk-example-sync
  milvus-release-notes-workflow
  sdk-reference-publisher
)

mkdir -p "$skill_root"

for skill in "${workflow_skills[@]}"; do
  src="$repo_root/skills/$skill"
  if [[ ! -f "$src/SKILL.md" ]]; then
    echo "Missing skill source: $src/SKILL.md" >&2
    exit 1
  fi
  rm -rf "$skill_root/$skill"
  cp -R "$src" "$skill_root/$skill"
  echo "installed $skill"
done

for skill in "${renamed_skills[@]}"; do
  if [[ -d "$skill_root/$skill" ]]; then
    rm -rf "$skill_root/$skill"
    echo "removed renamed $skill"
  fi
done

if [[ "$remove_legacy" == "1" ]]; then
  for skill in "${legacy_skills[@]}"; do
    if [[ -d "$skill_root/$skill" ]]; then
      rm -rf "$skill_root/$skill"
      echo "removed legacy $skill"
    fi
  done
fi

echo "Codex skills installed in $skill_root"
