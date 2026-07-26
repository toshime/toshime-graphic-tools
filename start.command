#!/bin/bash
# Double-click to launch the tools locally (UgoSketch / KiriSketch).
cd "$(dirname "$0")"
PORT=8000
# Pick a free port if 8000 is taken.
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "UgoSketch  → http://localhost:$PORT              (Ctrl+C to quit)"
echo "KiriSketch → http://localhost:$PORT/kirisketch.html"
( sleep 1; open "http://localhost:$PORT" ) &
python3 -m http.server "$PORT"
