#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="${NODE_BIN:-/Users/bytedance/.nvm/versions/node/v24.16.0/bin}:$PATH"
PYTHON="$ROOT_DIR/.venv-cloud/bin/python"

"$PYTHON" deploy/volcano/pg/local_pg.py start >/dev/null
export DATABASE_URL="$("$PYTHON" deploy/volcano/pg/local_test_pg.py create)"
export NODE_ENV=test
export CLOUD_MODE=1
export AUTH_ENABLED=true
export CLOUD_COOKIE_SECURE=false
export MULTIUSER_ENABLED=true
export ADMIN_USERNAME=e2e_owner
export ADMIN_PASSWORD=OwnerPassword12
export MULTIUSER_OWNER_USERNAME=e2e_owner
export AUTH_JWT_SECRET=e2e-jwt-secret-at-least-32-bytes-long
export MULTIUSER_CREDENTIAL_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export PORT="${MULTIUSER_WEB_PORT:-4191}"

cleanup() {
  "$PYTHON" deploy/volcano/pg/local_test_pg.py drop >/dev/null 2>&1 || true
}
trap cleanup EXIT
node --import tsx api/cloud/cloudServer.ts
