#!/usr/bin/env bash
set -euo pipefail

export CHANGFU_ADMIN_PORT="${PORT:-${CHANGFU_ADMIN_PORT:-8000}}"
export CHANGFU_ADMIN_HOST="${CHANGFU_ADMIN_HOST:-0.0.0.0}"
export CHANGFU_ADMIN_WEB_ROOT="${CHANGFU_ADMIN_WEB_ROOT:-/app/admin-web/dist}"

exec node dist/apps/admin/src/server.js
