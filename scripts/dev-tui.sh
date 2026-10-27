#!/usr/bin/env bash
# Open the TUI against the isolated dev Host started by dev-host.sh.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
socket="${DSHELL_SOCKET:-$root/.dsh-dev/run/dshell.sock}"

if [[ ! -S "$socket" ]]; then
  echo "no Host socket at $socket" >&2
  echo "start ./scripts/dev-host.sh in another terminal first" >&2
  exit 1
fi
if [[ ! -f "$root/dist/bin/dshell.js" ]]; then
  echo "the CLI is not built; run: pnpm build" >&2
  exit 1
fi

exec env DSHELL_SOCKET="$socket" node "$root/dist/bin/dshell.js" "$@"
