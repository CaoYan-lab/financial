#!/usr/bin/env bash
# veFaaS Web 函数入口：无状态 API + 前端静态站 + 鉴权 + 指令入队。
# 监听 0.0.0.0:8000（veFaaS Webserver 模式要求）。
set -euo pipefail

export APP_ROLE=web
export CLOUD_MODE=1
export CLOUD_PYTHON=1
export AUTH_ENABLED="${AUTH_ENABLED:-true}"
export CLOUD_COOKIE_SECURE="${CLOUD_COOKIE_SECURE:-true}"
export PORT="${PORT:-8000}"

cd /app

echo "[run-web] starting cloud web server on 0.0.0.0:${PORT}"
exec npx tsx api/cloud/cloudServer.ts
