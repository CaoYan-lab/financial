#!/usr/bin/env bash
# veFaaS 常驻 Worker 入口：四大交易引擎单例 + PG 任务队列消费 + 心跳快照。
# 常驻型函数：始终分配 CPU / 预留实例数=1 / 关闭单实例多并发。
# 健康端点 /health 监听 0.0.0.0:8000（供平台探活）。
set -euo pipefail

export APP_ROLE=worker
export CLOUD_MODE=1
export CLOUD_PYTHON=1
export PG_HISTORY_DRIVER=1
export PORT="${PORT:-8000}"
# 引擎历史走 PG、订阅进程用容器内 python
export FUTU_PYTHON_BIN="${FUTU_PYTHON_BIN:-/opt/venv/bin/python}"

cd /app

echo "[run-worker] starting cloud worker on 0.0.0.0:${PORT} (OpenD=${FUTU_OPEND_HOST:-unset})"
exec npx tsx api/cloud/worker/workerServer.ts
