#!/usr/bin/env bash
# Resolve the tip commit of refs/heads/<branch> on VENICE_PROXY_REPO and write it into
# Dockerfile, docker-compose.yml, and .env.example as VENICE_PROXY_REF.
#
# Usage:
#   ./scripts/update-venice-proxy-ref.sh [branch]
# Environment:
#   VENICE_PROXY_REPO — remote URL (default: https://github.com/jooray/venice-e2ee-proxy.git)
#
# Example:
#   ./scripts/update-venice-proxy-ref.sh
#   ./scripts/update-venice-proxy-ref.sh develop
#   VENICE_PROXY_REPO=https://github.com/you/fork.git ./scripts/update-venice-proxy-ref.sh main
#
# Uses sed through a temporary file rather than `sed -i`, because BSD sed on
# macOS (the maintainer's machine) requires a backup suffix and would otherwise
# fail, and GNU/BSD `-i` spellings are not compatible.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"
REPO="${VENICE_PROXY_REPO:-https://github.com/jooray/venice-e2ee-proxy.git}"

SHA="$(git ls-remote "$REPO" "refs/heads/${BRANCH}" | awk '{print $1; exit}')"
if [[ -z "$SHA" || "$SHA" == 0000000000000000000000000000000000000000 ]]; then
  echo "error: no commit found for refs/heads/${BRANCH} on ${REPO}" >&2
  exit 1
fi

# Rewrite in place without `sed -i`: same file, same permissions, no .bak left
# behind. `cat > file` truncates the existing inode instead of replacing it.
rewrite() {
  local file="$1" expr="$2" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  sed "$expr" "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

rewrite "${ROOT}/Dockerfile" "s|^ARG VENICE_PROXY_REF=.*|ARG VENICE_PROXY_REF=${SHA}|"
rewrite "${ROOT}/docker-compose.yml" "s|\${VENICE_PROXY_REF:-[^}]*}|\${VENICE_PROXY_REF:-${SHA}}|g"
rewrite "${ROOT}/.env.example" "s|^VENICE_PROXY_REF=.*|VENICE_PROXY_REF=${SHA}|"

echo "VENICE_PROXY_REF -> ${SHA} (branch ${BRANCH}, repo ${REPO})"
