#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="${NODE_BIN:-/Users/bytedance/.nvm/versions/node/v24.16.0/bin}:$PATH"
RESULT_DIR="$ROOT_DIR/.data/test-results"
mkdir -p "$RESULT_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS="failed"

finish() {
  local ended_at
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"startedAt":"%s","endedAt":"%s","status":"%s","externalSmoke":%s}\n' \
    "$STARTED_AT" "$ended_at" "$STATUS" "${RUN_EXTERNAL_READONLY_SMOKE:-0}" >"$RESULT_DIR/summary.json"
  printf '# 本地发布测试结果\n\n- 状态：%s\n- 开始：%s\n- 结束：%s\n- 外部只读冒烟：%s\n' \
    "$STATUS" "$STARTED_AT" "$ended_at" "${RUN_EXTERNAL_READONLY_SMOKE:-0}" >"$RESULT_DIR/summary.md"
}
trap finish EXIT

run_stage() {
  local name="$1"
  shift
  printf '[%s] %s\n' "$(date +%H:%M:%S)" "$name"
  "$@" 2>&1 | tee "$RESULT_DIR/${name}.log"
}

run_stage "01-typecheck" npm run check
run_stage "02-lint" npm run lint
run_stage "03-build" npm run build
run_stage "04-unit" npm run test:unit
run_stage "05-database" npm run test:integration:db
run_stage "06-http-worker" npm run test:integration:http
if [[ "${RUN_EXTERNAL_READONLY_SMOKE:-0}" == "1" ]]; then
  run_stage "07-external-readonly" ./scripts/test-external-readonly.sh
fi
run_stage "08-e2e" npm run test:e2e
STATUS="passed"
