#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache="${npm_config_cache:-$PWD/.cache/npm}"
mkdir -p "$npm_config_cache"

pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm pack

tarball="$(ls -1t landasika-dshell-*.tgz | head -1)"
test -n "$tarball"
printf 'packed: %s (%s bytes)\n' "$tarball" "$(stat -c %s "$tarball")"
rm -f "$tarball"
