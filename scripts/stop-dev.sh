#!/usr/bin/env bash
# Stop the Matrix macOS client dev server + Electron app (leaves Cursor/VSCode alone).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for port in 5173 5174 5175 5176 5177 5178 5179 5180; do
  pid=$(lsof -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill -9 $pid 2>/dev/null && echo "stopped vite on :$port (pid $pid)"
  fi
done
pkill -9 -f "$ROOT/node_modules/electron" 2>/dev/null && echo "stopped app electron"
pkill -9 -f "$ROOT/dist-electron/main.js" 2>/dev/null
echo "done."
