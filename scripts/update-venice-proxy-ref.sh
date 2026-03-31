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

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"
REPO="${VENICE_PROXY_REPO:-https://github.com/jooray/venice-e2ee-proxy.git}"

SHA="$(git ls-remote "$REPO" "refs/heads/${BRANCH}" | awk '{print $1; exit}')"
if [[ -z "$SHA" || "$SHA" == 0000000000000000000000000000000000000000 ]]; then
  echo "error: no commit found for refs/heads/${BRANCH} on ${REPO}" >&2
  exit 1
fi

sed -i "s|^ARG VENICE_PROXY_REF=.*|ARG VENICE_PROXY_REF=${SHA}|" "${ROOT}/Dockerfile"
sed -i "s|\${VENICE_PROXY_REF:-[^}]*}|\${VENICE_PROXY_REF:-${SHA}}|g" "${ROOT}/docker-compose.yml"
sed -i "s|^# VENICE_PROXY_REF=.*|# VENICE_PROXY_REF=${SHA}|" "${ROOT}/.env.example"

echo "VENICE_PROXY_REF -> ${SHA} (branch ${BRANCH}, repo ${REPO})"
