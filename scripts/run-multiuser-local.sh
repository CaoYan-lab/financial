#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

NODE_BIN="${NODE_BIN:-/Users/bytedance/.nvm/versions/node/v24.16.0/bin}"
export PATH="$NODE_BIN:$PATH"

WEB_PORT="${MULTIUSER_WEB_PORT:-4101}"
WORKER_PORT="${MULTIUSER_WORKER_PORT:-4102}"
RUNTIME_DIR="$ROOT_DIR/.data/multiuser-local"
mkdir -p "$RUNTIME_DIR"

if [[ ! -x "$ROOT_DIR/.venv-cloud/bin/python" ]]; then
  echo "缺少 .venv-cloud，本地 PostgreSQL 工具不可用。" >&2
  exit 1
fi

if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Web 端口 $WEB_PORT 已被占用，请设置 MULTIUSER_WEB_PORT。" >&2
  exit 1
fi
if lsof -nP -iTCP:"$WORKER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Worker 端口 $WORKER_PORT 已被占用，请设置 MULTIUSER_WORKER_PORT。" >&2
  exit 1
fi

"$ROOT_DIR/.venv-cloud/bin/python" deploy/volcano/pg/local_pg.py start
export DATABASE_URL
DATABASE_URL="$("$ROOT_DIR/.venv-cloud/bin/python" deploy/volcano/pg/local_pg.py uri)"
"$ROOT_DIR/.venv-cloud/bin/python" deploy/volcano/pg/apply_multiuser_schema.py

if [[ ! -f "$ROOT_DIR/.data/cloud-faas/secrets.env" ]]; then
  echo "缺少 .data/cloud-faas/secrets.env。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source "$ROOT_DIR/.data/cloud-faas/secrets.env"
set +a

: "${ADMIN_USERNAME:?缺少 ADMIN_USERNAME}"
: "${ADMIN_PASSWORD:?缺少 ADMIN_PASSWORD}"
: "${AUTH_JWT_SECRET:?缺少 AUTH_JWT_SECRET}"

export MULTIUSER_ENABLED=true
export MULTIUSER_OWNER_USERNAME="${MULTIUSER_OWNER_USERNAME:-$ADMIN_USERNAME}"
export MULTIUSER_LOCAL_DIRECT=true
export MULTIUSER_CREDENTIAL_MASTER_KEY="${MULTIUSER_CREDENTIAL_MASTER_KEY:-$(
  printf '%s' "$AUTH_JWT_SECRET:multiuser-local" | openssl dgst -sha256 -binary | openssl base64 -A
)}"
export CLOUD_MODE=1
export AUTH_ENABLED=true
export CLOUD_COOKIE_SECURE=false

echo "[1/3] 构建前端"
npx vite build >"$RUNTIME_DIR/build.log" 2>&1

cleanup() {
  trap - INT TERM EXIT
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "${WORKER_PID:-}" ]] && kill "$WORKER_PID" 2>/dev/null || true
  wait "${WEB_PID:-}" "${WORKER_PID:-}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[2/3] 启动多用户 Web"
PORT="$WEB_PORT" node --env-file=.env.local --import tsx api/cloud/cloudServer.ts >"$RUNTIME_DIR/web.log" 2>&1 &
WEB_PID=$!
echo "$WEB_PID" >"$RUNTIME_DIR/web.pid"

echo "[3/3] 启动多用户 Worker"
PORT="$WORKER_PORT" node --env-file=.env.local --import tsx api/cloud/worker/workerServer.ts >"$RUNTIME_DIR/worker.log" 2>&1 &
WORKER_PID=$!
echo "$WORKER_PID" >"$RUNTIME_DIR/worker.pid"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$WEB_PORT/api/auth/config" >/dev/null; then
    echo "本地多用户环境已启动：http://127.0.0.1:$WEB_PORT"
    echo "Web 日志：$RUNTIME_DIR/web.log"
    echo "Worker 日志：$RUNTIME_DIR/worker.log"
    wait "$WEB_PID" "$WORKER_PID"
    exit $?
  fi
  sleep 1
done

echo "本地 Web 启动超时，请检查 $RUNTIME_DIR/web.log" >&2
exit 1
