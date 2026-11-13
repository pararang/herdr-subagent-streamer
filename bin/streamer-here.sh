#!/bin/bash
# Start the subagent streamer for an opencode pane. Usage and options: src/here.mjs.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RT=$(command -v bun || command -v node) || { echo "streamer-here: needs bun or node" >&2; exit 1; }
exec "$RT" "$ROOT/src/here.mjs" "$@"
