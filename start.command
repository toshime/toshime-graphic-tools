#!/bin/bash
# Double-click to launch the tools locally (ゆらゆら / ばらばら / けろけろ).
cd "$(dirname "$0")"
PORT=8000
# Pick a free port if 8000 is taken.
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "ゆらゆら   → http://localhost:$PORT              (Ctrl+C to quit)"
echo "ばらばら   → http://localhost:$PORT/kirisketch.html"
echo "けろけろ   → http://localhost:$PORT/amisketch.html"
( sleep 1; open "http://localhost:$PORT" ) &
python3 -m http.server "$PORT"
