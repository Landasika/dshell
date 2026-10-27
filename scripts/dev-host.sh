#!/usr/bin/env bash
# Boot a DSH Host with the dshell plugin, isolated from ~/.dsh by default.
#
#   ./scripts/dev-host.sh              # foreground Host + Web UI
#   ./scripts/dev-host.sh --port 8080  # extra flags go to the profile app
#
# Override DSH_BIN to use a specific CLI, DSH_HOME to use another home, or
# DSH_PROFILE to use an existing profile.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

dsh_bin="${DSH_BIN:-}"
if [[ -z "$dsh_bin" ]]; then
  if dsh_path="$(type -P dsh 2>/dev/null)"; then
    dsh_bin="$dsh_path"
  else
    # The mayfly CLI ships a DSH runtime under ~/.dsh/cache. Use the newest
    # one when no global `dsh` is installed.
    for candidate in "$HOME"/.dsh/cache/mayfly-cli-runtime/*/node_modules/@deepseek-ai/dsh/lib/bin.js; do
      [[ -f "$candidate" ]] && dsh_bin="$candidate"
    done
  fi
fi

if [[ -z "$dsh_bin" || ! -f "$dsh_bin" ]]; then
  cat >&2 <<'EOF'
No dsh CLI found. Install it, or point DSH_BIN at the CLI entrypoint:

  DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js ./scripts/dev-host.sh

The Host must boot with the dshell plugin already loaded.
EOF
  exit 1
fi

export DSH_HOME="${DSH_HOME:-$root/.dsh-dev}"
profile="${DSH_PROFILE:-dshell}"
mkdir -p "$DSH_HOME"

run_dsh() {
  if [[ "$dsh_bin" == *.js ]]; then
    node "$dsh_bin" "$@"
  else
    "$dsh_bin" "$@"
  fi
}

if [[ ! -f "$DSH_HOME/profiles/$profile/package.json" ]]; then
  run_dsh "$profile" --from-default-profile web --dump-config >/dev/null
fi

# Idempotent: pnpm updates the profile dependency to this checkout.
run_dsh plugin --profile "$profile" add "$root"

if [[ "$dsh_bin" == *.js ]]; then
  exec node "$dsh_bin" "$profile" --no-open "$@"
else
  exec "$dsh_bin" "$profile" --no-open "$@"
fi
