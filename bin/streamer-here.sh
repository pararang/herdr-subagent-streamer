#!/bin/bash
# Start the subagent streamer for an opencode pane.
#
# This opencode build imports files in ~/.config/opencode/plugins but never calls their exported
# factory, so the plugin cannot hook session events (verified with a minimal reference plugin).
# Herdr already knows which session each pane runs, so take it from there instead.
#
#   streamer-here.sh [PANE_ID]           start now
#   streamer-here.sh --watch [PANE_ID]   wait for this pane to spawn a subagent, then start
#
# --watch is what the plugin uses: it keeps idle panes free of a streamer process, because most
# sessions never spawn a subagent at all.
set -u

HERDR=${HERDR:-herdr}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STREAMER="$ROOT/src/streamer.mjs"
WATCH=0
if [ "${1:-}" = "--watch" ]; then WATCH=1; shift; fi
PANE=${1:-${HERDR_PANE_ID:-}}

die() { echo "streamer-here: $*" >&2; exit 1; }

[ -f "$STREAMER" ] || die "no streamer at $STREAMER"
command -v "$HERDR" >/dev/null || die "herdr is not on PATH"

if [ -z "$PANE" ]; then
  PANE=$("$HERDR" pane get --current 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["pane"]["pane_id"])' 2>/dev/null)
fi
[ -n "$PANE" ] || die "no pane: pass one, or run inside herdr"

read -r AGENT SESSION <<EOF
$("$HERDR" pane get "$PANE" 2>/dev/null | python3 -c '
import sys, json
try:
    p = json.load(sys.stdin)["result"]["pane"]
except Exception:
    print("none none"); raise SystemExit
print(p.get("agent") or "none", (p.get("agent_session") or {}).get("value") or "none")
')
EOF

# STREAMER_SESSION pins the session by hand, for a run herdr does not register (`opencode run`)
# or when watching a session from another pane.
if [ -n "${STREAMER_SESSION:-}" ]; then
  AGENT=opencode
  SESSION=$STREAMER_SESSION
fi

[ "$AGENT" = "opencode" ] || [ "$WATCH" = 1 ] || die "pane $PANE runs '$AGENT', not opencode"
# A pane only gains a session once it is prompted, so watch mode waits rather than giving up.
if [ "$SESSION" = "none" ] && [ "$WATCH" = 0 ]; then
  die "pane $PANE has no opencode session yet; send it a prompt first"
fi

RT=$(command -v bun || command -v node) || die "needs bun or node"
DIR="${TMPDIR:-/tmp}/herdr-subagent-streamer"
mkdir -p "$DIR"
KEY=${PANE//[^A-Za-z0-9]/_}
PIDFILE="$DIR/$KEY.pid"
FEED="$DIR/$KEY.feed.jsonl"
LOG="$DIR/$KEY.log"

# One streamer per pane: a live one for this same session is already doing the job.
if [ -f "$PIDFILE" ]; then
  OLD=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("pid",""),d.get("session",""))' "$PIDFILE" 2>/dev/null)
  set -- $OLD
  if [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; then
    if [ "${2:-}" = "$SESSION" ]; then echo "already streaming $SESSION (pid $1)"; exit 0; fi
    kill "$1" 2>/dev/null
  fi
fi

SINCE_MS=$(python3 -c 'import time;print(int(time.time()*1000))')

if [ "$WATCH" = 1 ]; then
  DB=${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}
  # Poll cheaply until this session actually spawns a subagent; a pane that never does costs
  # nothing but this shell.
  while :; do
    sleep 5
    LIVE=$("$HERDR" pane get "$PANE" 2>/dev/null | python3 -c '
import sys, json
try: print((json.load(sys.stdin)["result"]["pane"].get("agent_session") or {}).get("value") or "")
except Exception: print("")')
    "$HERDR" pane get "$PANE" >/dev/null 2>&1 || exit 0   # pane closed: stop watching
    # Herdr reports no session before the first prompt, and again whenever a run does not register
    # one, so only a different non-empty session replaces what we are watching.
    if [ -n "${STREAMER_SESSION:-}" ]; then
      LIVE=$STREAMER_SESSION
    fi
    if [ -n "$LIVE" ] && [ "$LIVE" != "$SESSION" ]; then
      SESSION=$LIVE
      SINCE_MS=$(python3 -c 'import time;print(int(time.time()*1000))')
    fi
    [ "$SESSION" != "none" ] || continue
    N=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM session_v2 WHERE parent_id='$SESSION' AND time_created >= $SINCE_MS;" 2>/dev/null)
    [ "${N:-0}" -gt 0 ] && break
  done
fi

printf '{"type":"session","id":"%s"}\n' "$SESSION" > "$FEED"
# `since` scopes the view to subagents spawned from now on, not the session's whole history.
CFG=$(SESSION="$SESSION" FEED="$FEED" SINCE="$SINCE_MS" python3 -c '
import base64, json, os
print(base64.urlsafe_b64encode(json.dumps({
    "host": "opencode", "session": os.environ["SESSION"], "feed": os.environ["FEED"],
    "pid": os.getpid(), "since": int(os.environ["SINCE"]),
}).encode()).decode().rstrip("="))')

HERDR_SUBAGENT_STREAMER_HOST=opencode HERDR_ENV=1 HERDR_PANE_ID="$PANE" \
  nohup "$RT" "$STREAMER" auto "$CFG" >> "$LOG" 2>&1 &
NEW=$!
disown 2>/dev/null
python3 -c 'import json,sys;json.dump({"pid":int(sys.argv[1]),"owner":0,"session":sys.argv[2]},open(sys.argv[3],"w"))' "$NEW" "$SESSION" "$PIDFILE"
echo "streaming subagents of $SESSION for pane $PANE (pid $NEW, log $LOG)"
