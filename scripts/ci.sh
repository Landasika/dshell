#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache="${npm_config_cache:-$PWD/.cache/npm}"
mkdir -p "$npm_config_cache"

pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
./scripts/verify-pack.sh
