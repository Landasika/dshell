#!/usr/bin/env bash
# Re-record the dshell promo: scripted TUI run -> frames -> 1080p mp4.
#
#   docs/promo/record.sh              # full run
#   docs/promo/record.sh --frames     # frames only, no encoding
#
# Requires: node + pnpm build, python3 with Pillow and fontTools, ffmpeg.
set -euo pipefail

cd "$(dirname "$0")/../.."

mkdir -p docs/promo/out
pnpm build
node docs/promo/demo.mjs
python3 docs/promo/render.py "$@"
echo "done: docs/promo/out/dshell-promo.mp4"
