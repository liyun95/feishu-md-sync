#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skill_root="${CODEX_HOME:-"$HOME/.codex"}/skills"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat <<'USAGE'
Usage: scripts/install-codex-skills.sh

Install the Feishu workflow Codex skills from this repository into:
  ${CODEX_HOME:-$HOME/.codex}/skills
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
  feishu-multisdk-examples
  feishu-sdk-reference-authoring
  feishu-sdk-reference-release
  feishu-release-notes
)

retired_workflow_skills=(
  feishu-baseline-sync
  feishu-publish-new
  feishu-push
  feishu-reviewed-section-sync
  feishu-section-sync
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

for skill in "${retired_workflow_skills[@]}"; do
  if [[ -d "$skill_root/$skill" ]]; then
    rm -rf "$skill_root/$skill"
    echo "removed retired workflow $skill"
  fi
done

echo "Codex skills installed in $skill_root"
