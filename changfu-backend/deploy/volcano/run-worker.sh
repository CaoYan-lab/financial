#!/usr/bin/env bash
set -euo pipefail

export CHANGFU_DECISION_WORKER_HOST=0.0.0.0
export CHANGFU_DECISION_WORKER_PORT="${PORT:-8000}"

exec node /app/dist/apps/decision-worker/src/server.js
