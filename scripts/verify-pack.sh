#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

export npm_config_cache="$work/npm-cache"
mkdir -p "$npm_config_cache"

pnpm build >/dev/null
pnpm pack --pack-destination "$work" >/dev/null
tarball="$(ls -1t "$work"/landasika-dshell-*.tgz | head -1)"
test -n "$tarball"

# The published artifact must contain the runtime plugin, CLI and patch, but
# never local test state, docs/development, or credentials.
entries="$(tar -tzf "$tarball")"
grep -qx 'package/dist/plugin/index.js' <<< "$entries"
grep -qx 'package/dist/bin/dshell.js' <<< "$entries"
grep -qx 'package/cordis.patch.yml' <<< "$entries"
if grep -Eq '(^|/)(\.p0|\.cache|docs/development|\.credentials\.yaml)(/|$)' <<< "$entries"; then
  echo "pack artifact contains local/test files" >&2
  exit 1
fi

mkdir -p "$work/app"
npm install --prefix "$work/app" --no-audit --no-fund --ignore-scripts "$tarball" >/dev/null
"$work/app/node_modules/.bin/dshell" --version
node --input-type=module - "$work/app" <<'NODE'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const app = process.argv[2]
const plugin = await import(pathToFileURL(join(app, 'node_modules/@landasika/dshell/dist/plugin/index.js')).href)
if (plugin.name !== 'dshell-host') throw new Error('installed plugin export is broken')
const pkg = await import(pathToFileURL(join(app, 'node_modules/@landasika/dshell/package.json')).href, { with: { type: 'json' } })
if (pkg.default.name !== '@landasika/dshell') throw new Error('installed package name is wrong')
console.log(`installed plugin: ${plugin.name}`)
NODE

sha256sum "$tarball"
printf 'verified: %s (%s bytes)\n' "$(basename "$tarball")" "$(stat -c %s "$tarball")"
