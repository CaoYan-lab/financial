#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="${NODE_BIN:-/Users/bytedance/.nvm/versions/node/v24.16.0/bin}:$PATH"

if [[ "${RUN_EXTERNAL_READONLY_SMOKE:-0}" != "1" ]]; then
  echo "未设置 RUN_EXTERNAL_READONLY_SMOKE=1，拒绝执行真实外部冒烟。" >&2
  exit 2
fi

for key in FUTU_LIVE_TRADING_ENABLED LONGBRIDGE_LIVE_TRADING_ENABLED LIVE_TRADING_ENABLED; do
  if [[ "${!key:-false}" == "true" ]]; then
    echo "检测到 $key=true，拒绝执行只读冒烟。" >&2
    exit 3
  fi
done

export FUTU_LIVE_TRADING_ENABLED=false
export LONGBRIDGE_LIVE_TRADING_ENABLED=false
export LIVE_TRADING_ENABLED=false
node --env-file-if-exists=.env.local \
  --env-file-if-exists=.data/cloud-faas/secrets.env \
  ./node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts tests/smoke/*.smoke.test.ts \
  --pool=threads --maxWorkers=1
