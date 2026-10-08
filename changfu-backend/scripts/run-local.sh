#!/usr/bin/env bash
set -euo pipefail

BACKEND_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINANCIAL_ROOT="$(cd "${BACKEND_ROOT}/.." && pwd)"
RUNTIME_DIR="${FINANCIAL_ROOT}/.data/changfu-backend"
NODE_BIN="${FINANCIAL_ROOT}/.tools/node/bin/node"
NPM_BIN="${FINANCIAL_ROOT}/.tools/node/bin/npm"
ENV_FILE="${FINANCIAL_ROOT}/.env.local"

mkdir -p "${RUNTIME_DIR}"
umask 077

if [[ ! -x "${NODE_BIN}" || ! -x "${NPM_BIN}" ]]; then
  printf '[长富后台] 缺少项目 Node.js 工具链\n' >&2
  exit 1
fi

if [[ ! -S "${FINANCIAL_ROOT}/.data/cloud-pg/pgdata/.s.PGSQL.5432" ]]; then
  printf '[长富后台] 本地 PostgreSQL Unix Socket 未运行\n' >&2
  exit 1
fi

if [[ ! -s "${RUNTIME_DIR}/access-private.pem" ]]; then
  RUNTIME_DIR="${RUNTIME_DIR}" "${NODE_BIN}" --input-type=module - <<'NODE'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
writeFileSync(
  join(process.env.RUNTIME_DIR, 'access-private.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600 },
)
writeFileSync(
  join(process.env.RUNTIME_DIR, 'access-public.pem'),
  publicKey.export({ type: 'spki', format: 'pem' }),
  { mode: 0o600 },
)
writeFileSync(
  join(process.env.RUNTIME_DIR, 'internal-token'),
  randomBytes(48).toString('base64url'),
  { mode: 0o600 },
)
NODE
fi

if [[ ! -s "${RUNTIME_DIR}/order-intent-private.pem" ]]; then
  RUNTIME_DIR="${RUNTIME_DIR}" "${NODE_BIN}" --input-type=module - <<'NODE'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
writeFileSync(
  join(process.env.RUNTIME_DIR, 'order-intent-private.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600 },
)
writeFileSync(
  join(process.env.RUNTIME_DIR, 'order-intent-public.pem'),
  publicKey.export({ type: 'spki', format: 'pem' }),
  { mode: 0o600 },
)
NODE
fi

if [[ ! -s "${RUNTIME_DIR}/internal-token" ]]; then
  "${NODE_BIN}" -e \
    "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" \
    > "${RUNTIME_DIR}/internal-token"
fi

if [[ ! -s "${RUNTIME_DIR}/model-credential-key" ]]; then
  "${NODE_BIN}" -e \
    "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" \
    > "${RUNTIME_DIR}/model-credential-key"
fi

read_env_value() {
  sed -n "s/^$1=//p" "${ENV_FILE}" | tail -1
}

read_gate_value() {
  local primary="$1"
  local fallback="$2"
  local value
  value="$(read_env_value "${primary}")"
  if [[ -z "${value}" ]]; then
    value="$(read_env_value "${fallback}")"
  fi
  [[ "${value}" == "true" ]] && printf 'true' || printf 'false'
}

stop_service() {
  local pid_file="$1"
  local port="$2"
  local entrypoint="$3"
  local pids=()
  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}")"
    [[ "$pid" =~ ^[0-9]+$ ]] && pids+=("$pid")
  fi
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] && pids+=("$pid")
  done < <(lsof -nP -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)

  for pid in "${pids[@]-}"; do
    local command=""
    command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"${BACKEND_ROOT}/${entrypoint}"* ]]; then
      kill "${pid}" 2>/dev/null || true
    fi
  done

  for _ in {1..20}; do
    if ! lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      rm -f "${pid_file}"
      return
    fi
    sleep 0.1
  done
  printf '[长富后台] 无法停止本项目占用端口 %s 的旧服务\n' "${port}" >&2
  exit 1
}

printf '[长富后台] 编译 Gateway 与 Decision Worker\n'
(
  cd "${BACKEND_ROOT}"
  PATH="${FINANCIAL_ROOT}/.tools/node/bin:${PATH}" "${NPM_BIN}" run build
)

export CHANGFU_DATABASE_URL="postgresql://postgres:@/financial?host=${FINANCIAL_ROOT}/.data/cloud-pg/pgdata"
printf '[长富后台] 应用数据库迁移\n'
(
  cd "${BACKEND_ROOT}"
  PATH="${FINANCIAL_ROOT}/.tools/node/bin:${PATH}" "${NPM_BIN}" run db:migrate
)

launchctl remove com.changfu.gateway.local 2>/dev/null || true
launchctl remove com.changfu.worker.local 2>/dev/null || true
for _ in {1..50}; do
  if ! lsof -nP -iTCP:4310 -sTCP:LISTEN >/dev/null 2>&1 \
    && ! lsof -nP -iTCP:4311 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
stop_service "${RUNTIME_DIR}/gateway.pid" 4310 "dist/apps/gateway/src/server.js"
stop_service "${RUNTIME_DIR}/worker.pid" 4311 "dist/apps/decision-worker/src/server.js"

export CHANGFU_INTERNAL_TOKEN
CHANGFU_INTERNAL_TOKEN="$(cat "${RUNTIME_DIR}/internal-token")"
export CHANGFU_MODEL_CREDENTIAL_KEY
CHANGFU_MODEL_CREDENTIAL_KEY="$(cat "${RUNTIME_DIR}/model-credential-key")"
export CHANGFU_ARK_API_KEY
CHANGFU_ARK_API_KEY="$(read_env_value ARK_API_KEY)"
export CHANGFU_ARK_MODEL
CHANGFU_ARK_MODEL="$(read_env_value ARK_MODEL)"
export CHANGFU_ARK_ENDPOINT
CHANGFU_ARK_ENDPOINT="$(read_env_value ARK_RESPONSES_URL)"
export CHANGFU_SEC_USER_AGENT
CHANGFU_SEC_USER_AGENT="$(read_env_value CHANGFU_SEC_USER_AGENT)"
export CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM
CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM="$(cat "${RUNTIME_DIR}/order-intent-private.pem")"
export CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM
CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM="$(cat "${RUNTIME_DIR}/order-intent-public.pem")"
export CHANGFU_ORDER_INTENT_KEY_ID=changfu-order-local-v1
export CHANGFU_FUTU_LIVE_TRADING_ENABLED
CHANGFU_FUTU_LIVE_TRADING_ENABLED="$(
  read_gate_value CHANGFU_FUTU_LIVE_TRADING_ENABLED LIVE_TRADING_ENABLED
)"
export CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED
CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED="$(
  read_gate_value CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED LONGBRIDGE_LIVE_TRADING_ENABLED
)"

printf '[长富后台] 启动 Decision Worker，日志：%s\n' "${RUNTIME_DIR}/worker.log"
launchctl submit \
  -l com.changfu.worker.local \
  -o "${RUNTIME_DIR}/worker.log" \
  -e "${RUNTIME_DIR}/worker.log" \
  -- /usr/bin/env \
  "CHANGFU_DATABASE_URL=${CHANGFU_DATABASE_URL}" \
  "CHANGFU_INTERNAL_TOKEN=${CHANGFU_INTERNAL_TOKEN}" \
  "CHANGFU_MODEL_CREDENTIAL_KEY=${CHANGFU_MODEL_CREDENTIAL_KEY}" \
  "CHANGFU_ARK_API_KEY=${CHANGFU_ARK_API_KEY}" \
  "CHANGFU_ARK_MODEL=${CHANGFU_ARK_MODEL}" \
  "CHANGFU_ARK_ENDPOINT=${CHANGFU_ARK_ENDPOINT}" \
  "CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM=${CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM}" \
  "CHANGFU_ORDER_INTENT_KEY_ID=${CHANGFU_ORDER_INTENT_KEY_ID}" \
  "CHANGFU_SEC_USER_AGENT=${CHANGFU_SEC_USER_AGENT}" \
  "CHANGFU_FUTU_LIVE_TRADING_ENABLED=${CHANGFU_FUTU_LIVE_TRADING_ENABLED}" \
  "CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED=${CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED}" \
  CHANGFU_DECISION_WORKER_HOST=127.0.0.1 \
  CHANGFU_DECISION_WORKER_PORT=4311 \
  "${NODE_BIN}" "${BACKEND_ROOT}/dist/apps/decision-worker/src/server.js"

export CHANGFU_ACCESS_PRIVATE_KEY_PEM
CHANGFU_ACCESS_PRIVATE_KEY_PEM="$(cat "${RUNTIME_DIR}/access-private.pem")"
export CHANGFU_ACCESS_PUBLIC_KEY_PEM
CHANGFU_ACCESS_PUBLIC_KEY_PEM="$(cat "${RUNTIME_DIR}/access-public.pem")"
export CHANGFU_ACCESS_KEY_ID=changfu-local-v1
export CHANGFU_DECISION_WORKER_URL=http://127.0.0.1:4311

printf '[长富后台] 启动 Gateway，日志：%s\n' "${RUNTIME_DIR}/gateway.log"
launchctl submit \
  -l com.changfu.gateway.local \
  -o "${RUNTIME_DIR}/gateway.log" \
  -e "${RUNTIME_DIR}/gateway.log" \
  -- /usr/bin/env \
  "CHANGFU_DATABASE_URL=${CHANGFU_DATABASE_URL}" \
  "CHANGFU_INTERNAL_TOKEN=${CHANGFU_INTERNAL_TOKEN}" \
  "CHANGFU_MODEL_CREDENTIAL_KEY=${CHANGFU_MODEL_CREDENTIAL_KEY}" \
  "CHANGFU_ACCESS_PRIVATE_KEY_PEM=${CHANGFU_ACCESS_PRIVATE_KEY_PEM}" \
  "CHANGFU_ACCESS_PUBLIC_KEY_PEM=${CHANGFU_ACCESS_PUBLIC_KEY_PEM}" \
  "CHANGFU_ACCESS_KEY_ID=${CHANGFU_ACCESS_KEY_ID}" \
  "CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM=${CHANGFU_ORDER_INTENT_PUBLIC_KEY_PEM}" \
  "CHANGFU_ORDER_INTENT_KEY_ID=${CHANGFU_ORDER_INTENT_KEY_ID}" \
  "CHANGFU_SEC_USER_AGENT=${CHANGFU_SEC_USER_AGENT}" \
  "CHANGFU_FUTU_LIVE_TRADING_ENABLED=${CHANGFU_FUTU_LIVE_TRADING_ENABLED}" \
  "CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED=${CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED}" \
  "CHANGFU_DECISION_WORKER_URL=${CHANGFU_DECISION_WORKER_URL}" \
  CHANGFU_GATEWAY_HOST=127.0.0.1 \
  CHANGFU_GATEWAY_PORT=4310 \
  "${NODE_BIN}" "${BACKEND_ROOT}/dist/apps/gateway/src/server.js"

for _ in {1..30}; do
  gateway_pid="$(lsof -nP -tiTCP:4310 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  worker_pid="$(lsof -nP -tiTCP:4311 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [[ -n "${gateway_pid}" && -n "${worker_pid}" ]] \
    && curl -fsS http://127.0.0.1:4310/v1/ready >/dev/null \
    && curl -fsS http://127.0.0.1:4311/internal/v1/health >/dev/null; then
    printf '%s\n' "${gateway_pid}" > "${RUNTIME_DIR}/gateway.pid"
    printf '%s\n' "${worker_pid}" > "${RUNTIME_DIR}/worker.pid"
    printf '[长富后台] Gateway 与 Decision Worker 已就绪\n'
    exit 0
  fi
  sleep 0.2
done

printf '[长富后台] 服务健康检查失败，请查看运行日志\n' >&2
exit 1
