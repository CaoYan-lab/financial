#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_ERROR_LOG="${API_ERROR_LOG:-/tmp/financial-api-error.log}"
FRONTEND_ERROR_LOG="${FRONTEND_ERROR_LOG:-/tmp/financial-frontend-error.log}"

cd "$ROOT_DIR"

mkdir -p "$(dirname "$API_ERROR_LOG")" "$(dirname "$FRONTEND_ERROR_LOG")"
: > "$API_ERROR_LOG"
: > "$FRONTEND_ERROR_LOG"

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

LOG_LEVEL=error LLM_REQUEST_SPREAD_WINDOW_MS="${LLM_REQUEST_SPREAD_WINDOW_MS:-5000}" npm run server:dev > "$API_ERROR_LOG" 2>&1 &
API_PID=$!

npm run client:dev > /dev/null 2> "$FRONTEND_ERROR_LOG" &
FRONTEND_PID=$!

printf 'Backend started on http://localhost:3001, errors: %s\n' "$API_ERROR_LOG"
printf 'Frontend started on http://localhost:5173, errors: %s\n' "$FRONTEND_ERROR_LOG"
printf 'Press Ctrl+C to stop both processes.\n'

wait "$API_PID" "$FRONTEND_PID"
