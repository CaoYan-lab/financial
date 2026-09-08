#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="${NODE_BIN:-/Users/bytedance/.nvm/versions/node/v24.16.0/bin}:$PATH"
PYTHON="$ROOT_DIR/.venv-cloud/bin/python"

"$PYTHON" deploy/volcano/pg/local_pg.py start >/dev/null
export DATABASE_URL="$("$PYTHON" deploy/volcano/pg/local_test_pg.py create)"
export RUN_PG_INTEGRATION=1
trap '"$PYTHON" deploy/volcano/pg/local_test_pg.py drop' EXIT

if [[ "$#" -gt 0 ]]; then
  npx vitest run --config vitest.integration.config.ts "$@" --pool=threads --maxWorkers=1
else
  npx vitest run --config vitest.integration.config.ts \
    tests/cloud/pgHistoryDriver.integration.test.ts \
    tests/cloud/jobQueue.integration.test.ts \
    tests/multiuser/*.integration.test.ts \
    --pool=threads --maxWorkers=1
fi
