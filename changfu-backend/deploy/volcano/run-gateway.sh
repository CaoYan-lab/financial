#!/usr/bin/env bash
set -euo pipefail

export CHANGFU_GATEWAY_HOST=0.0.0.0
export CHANGFU_GATEWAY_PORT="${PORT:-8000}"

exec node /app/dist/apps/gateway/src/server.js
