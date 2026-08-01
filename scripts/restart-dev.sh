#!/usr/bin/env bash
# Restart the Matrix macOS client dev server + Electron app.
# Kills ONLY this project's vite/electron — won't touch Cursor/VSCode.
# Usage: bash scripts/restart-dev.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

echo "→ stopping previous instances..."
for port in 5173 5174 5175 5176 5177 5178 5179 5180; do
  pid=$(lsof -iTCP:$port -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill -9 $pid 2>/dev/null && echo "  killed vite on :$port (pid $pid)"
  fi
done
# Only the project's own electron (path includes our node_modules / dist-electron)
pkill -9 -f "$ROOT/node_modules/electron" 2>/dev/null && echo "  killed app electron"
pkill -9 -f "$ROOT/dist-electron/main.js" 2>/dev/null

sleep 1
echo "→ starting 'npm run dev' (detached)..."
rm -f /tmp/matrix-dev.log
nohup npm run dev > /tmp/matrix-dev.log 2>&1 &
disown

sleep 7
echo
echo "→ dev log (head):"
head -24 /tmp/matrix-dev.log
echo
echo "✓ restarted. Electron window should open."
echo "  tail log:  tail -f /tmp/matrix-dev.log"
echo "  stop:      bash scripts/stop-dev.sh   (or just close the window)"
