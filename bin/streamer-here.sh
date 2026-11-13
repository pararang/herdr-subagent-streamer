#!/bin/bash
# Start the subagent streamer for an opencode pane. Usage and options: src/here.mjs.
#
#   streamer-here.sh [PANE_ID]           start now
#   streamer-here.sh --watch [PANE_ID]   wait for this pane to spawn a subagent, then start
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RT=$(command -v bun || command -v node) || { echo "streamer-here: needs bun or node" >&2; exit 1; }
exec "$RT" "$ROOT/src/here.mjs" "$@"
