#!/usr/bin/env bash
#
# Donna — one-command demo launcher.
# Boots the backend (Hono, :8787) and the frontend (Vite, :5173) in mock mode —
# zero API keys, zero network. Ctrl-C stops both.
#
# Usage:  ./scripts/demo.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

BACKEND_PORT="${PORT:-8787}"
FRONTEND_PORT="5173"

echo "▶ Donna demo — mock mode (no keys required)"
echo "  backend  : http://localhost:$BACKEND_PORT"
echo "  frontend : http://localhost:$FRONTEND_PORT"
echo

# --- dependency check ---------------------------------------------------------
if [ ! -d "$BACKEND/node_modules" ]; then
  echo "Installing backend deps..."
  (cd "$BACKEND" && npm install)
fi
if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "Installing frontend deps..."
  (cd "$FRONTEND" && npm install)
fi

# --- clean shutdown of both children on exit ----------------------------------
PIDS=()
cleanup() {
  echo
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- boot backend -------------------------------------------------------------
echo "Starting backend..."
(cd "$BACKEND" && PORT="$BACKEND_PORT" npm run dev) &
PIDS+=($!)

# wait for backend health before starting the frontend
echo -n "Waiting for backend"
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    echo " — up."
    break
  fi
  echo -n "."
  sleep 1
done

# --- boot frontend ------------------------------------------------------------
echo "Starting frontend..."
(cd "$FRONTEND" && npm run dev) &
PIDS+=($!)

# --- open the browser (best effort) -------------------------------------------
URL="http://localhost:$FRONTEND_PORT"
sleep 2
if command -v open >/dev/null 2>&1; then
  open "$URL" 2>/dev/null || true       # macOS
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" 2>/dev/null || true    # Linux
fi

echo
echo "✅ Donna is live. Open $URL — click '▶ Canned demo' to run the scenario."
echo "   Press Ctrl-C to stop both servers."
echo

# keep the script alive until a child exits or the user hits Ctrl-C
wait
