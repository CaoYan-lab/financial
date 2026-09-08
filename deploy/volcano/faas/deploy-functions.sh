#!/usr/bin/env bash
# 创建/更新 veFaaS 函数（Web + Worker），基于 veFaaS OpenAPI CreateFunction/UpdateFunctionResource。
#
# 说明：veFaaS 官方 Terraform 资源较新且字段不全（VPC/镜像/常驻策略/环境变量组合），
#       因此函数用 OpenAPI（CLI）部署更可靠；VPC/RDS/ECS 用 Terraform（见 deploy/volcano/terraform）。
#       本脚本生成 CreateFunction 的 JSON 请求体并调用 OpenAPI（签名用火山 CLI 或 veadk/SDK）。
#
# 依赖：jq；以及可用火山 API 调用方式（volcengine CLI 或 Python volcengine SDK）。
# 环境变量：
#   VOLC_ACCESSKEY / VOLC_SECRETKEY   火山 AK/SK
#   REGION                             地域，默认 cn-beijing
#   IMAGE_WEB / IMAGE_WORKER           CR 镜像地址 host/ns/repo:tag
#   RDS_DATABASE_URL                   AIDAP/RDS 连接串
#   FUTU_OPEND_HOST                    OpenD Windows ECS 内网 IP
#   AUTH_JWT_SECRET / ADMIN_USERNAME / ADMIN_PASSWORD
#   ARK_API_KEY / LONGBRIDGE_* 等业务密钥
#   VPC_ID / SUBNET_ID / SG_FAAS_ID    来自 terraform output
set -euo pipefail

: "${REGION:=cn-beijing}"
: "${IMAGE_WEB:?需设置 CR 镜像地址 IMAGE_WEB，如 xxx-cn-beijing.cr.volces.com/fin/financial-workbench:<tag>}"
: "${RDS_DATABASE_URL:?需设置 RDS_DATABASE_URL}"
: "${VPC_ID:?}" ; : "${SUBNET_ID:?}" ; : "${SG_FAAS_ID:?}"
: "${AUTH_JWT_SECRET:?}" ; : "${ADMIN_USERNAME:?}" ; : "${ADMIN_PASSWORD:?}"
if [[ -n "${IMAGE_WORKER:-}" ]]; then
  : "${LONGBRIDGE_ORDER_PROXY_URL:?Worker 发布必须配置 LONGBRIDGE_ORDER_PROXY_URL，确保 admin 与多用户订单统一经过 HeySocks}"
fi
if [[ "${MULTIUSER_ENABLED:-false}" == "true" ]]; then
  : "${MULTIUSER_CREDENTIAL_MASTER_KEY:?启用多用户时必须配置 MULTIUSER_CREDENTIAL_MASTER_KEY}"
  command -v python3 >/dev/null 2>&1 || { echo "校验多用户主密钥需要 python3"; exit 1; }
  if ! printf '%s' "$MULTIUSER_CREDENTIAL_MASTER_KEY" | python3 -c '
import base64
import binascii
import sys

try:
    decoded = base64.b64decode(sys.stdin.buffer.read().strip(), validate=True)
except (binascii.Error, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if len(decoded) == 32 else 1)
'; then
    echo "MULTIUSER_CREDENTIAL_MASTER_KEY 必须为 32 字节随机值的 Base64 编码"
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v jq >/dev/null 2>&1 || { echo "需要 jq，请先安装"; exit 1; }

mkdir -p "$SCRIPT_DIR/out"

# 构造环境变量数组（OpenAPI Envs: [{"Key":..,"Value":..}]）
envs_array() {
  local role="$1"
  jq -n --arg db "$RDS_DATABASE_URL" --arg role "$role" \
        --arg jwt "$AUTH_JWT_SECRET" --arg admin "$ADMIN_USERNAME" --arg admink "$ADMIN_PASSWORD" \
        --arg opend "${FUTU_OPEND_HOST:-}" --arg arkkey "${ARK_API_KEY:-}" \
        --arg lbk "${LONGBRIDGE_APP_KEY:-}" --arg lbs "${LONGBRIDGE_APP_SECRET:-}" --arg lbt "${LONGBRIDGE_ACCESS_TOKEN:-}" \
        --arg lblive "${LONGBRIDGE_LIVE_TRADING_ENABLED:-false}" \
        --arg lbauto "${LONGBRIDGE_AUTO_SUBMIT_ENABLED:-false}" \
        --arg lbproxy "${LONGBRIDGE_ORDER_PROXY_URL:-}" \
        --arg multiuser "${MULTIUSER_ENABLED:-false}" \
        --arg multiowner "${MULTIUSER_OWNER_USERNAME:-$ADMIN_USERNAME}" \
        --arg multikey "${MULTIUSER_CREDENTIAL_MASTER_KEY:-}" \
        --arg live "${LIVE_TRADING_ENABLED:-false}" \
    '([
      {Key:"CLOUD_MODE",Value:"1"},
      {Key:"CLOUD_PYTHON",Value:"1"},
      {Key:"AUTH_ENABLED",Value:"true"},
      {Key:"CLOUD_COOKIE_SECURE",Value:"true"},
      {Key:"DATABASE_URL",Value:$db},
      {Key:"AUTH_JWT_SECRET",Value:$jwt},
      {Key:"ADMIN_USERNAME",Value:$admin},
      {Key:"ADMIN_PASSWORD",Value:$admink},
      {Key:"MULTIUSER_ENABLED",Value:$multiuser},
      {Key:"MULTIUSER_OWNER_USERNAME",Value:$multiowner},
      {Key:"MULTIUSER_CREDENTIAL_MASTER_KEY",Value:$multikey},
      {Key:"PG_HISTORY_DRIVER",Value:"1"},
      {Key:"FUTU_PYTHON_BIN",Value:"/opt/venv/bin/python"},
      {Key:"VOLCANO_CLOUD_PYTHONPATH",Value:"/app/deploy/volcano/pg/python"}
    ]
    + (if $role=="worker" then [
        {Key:"APP_ROLE",Value:"worker"},
        {Key:"FUTU_OPEND_HOST",Value:$opend},
        {Key:"FUTU_OPEND_PORT",Value:"11111"},
        {Key:"ARK_API_KEY",Value:$arkkey},
        {Key:"LONGBRIDGE_APP_KEY",Value:$lbk},
        {Key:"LONGBRIDGE_APP_SECRET",Value:$lbs},
        {Key:"LONGBRIDGE_ACCESS_TOKEN",Value:$lbt},
        {Key:"LONGBRIDGE_LIVE_TRADING_ENABLED",Value:$lblive},
        {Key:"LONGBRIDGE_AUTO_SUBMIT_ENABLED",Value:$lbauto},
        {Key:"LONGBRIDGE_ORDER_PROXY_URL",Value:$lbproxy},
        {Key:"LIVE_TRADING_ENABLED",Value:$live}
      ] else [
        {Key:"APP_ROLE",Value:"web"}
      ] end))
    | map(select(.Value != "" and .Value != null))'
}

build_function_json() {
  local name="$1" image="$2" role="$3" command="$4" cpu_strategy="$5"
  local envs
  envs="$(envs_array "$role")"
  jq -n \
    --arg name "$name" --arg image "$image" --arg cmd "$command" \
    --arg vpc "$VPC_ID" --arg subnet "$SUBNET_ID" --arg sg "$SG_FAAS_ID" \
    --arg cpustrat "$cpu_strategy" --argjson envs "$envs" \
    '{
      Name: $name,
      Runtime: "native/v1",
      SourceType: "image",
      Source: $image,
      Command: $cmd,
      Port: 8000,
      MemoryMB: 2048,
      CpuMilli: 2000,
      RequestTimeout: 900,
      ExclusiveMode: (if $cpustrat == "always" then true else false end),
      CpuStrategy: $cpustrat,
      MaxConcurrency: 50,
      Envs: $envs,
      VpcConfig: { EnableVpc: true, VpcId: $vpc, SubnetIds: [$subnet], SecurityGroupIds: [$sg] }
    }'
}

build_function_json "fin-web" "$IMAGE_WEB" web "bash deploy/volcano/faas/run-web.sh" "burstable" \
  > "$SCRIPT_DIR/out/fin-web.create.json"
echo "[OK] Web 函数请求体: $SCRIPT_DIR/out/fin-web.create.json"

if [ -n "${IMAGE_WORKER:-}" ]; then
  build_function_json "fin-worker" "$IMAGE_WORKER" worker "bash deploy/volcano/faas/run-worker.sh" "always" \
    > "$SCRIPT_DIR/out/fin-worker.create.json"
  echo "[OK] Worker 函数请求体: $SCRIPT_DIR/out/fin-worker.create.json"
fi

cat <<'EOF'

请求体已生成。实际调用 OpenAPI 二选一：

方式 A（推荐，volcengine Python SDK）：
  python deploy/volcano/faas/call_create_function.py fin-web
  python deploy/volcano/faas/call_create_function.py fin-worker

方式 B（火山 CLI）：按控制台「OpenAPI 调试」用生成的 JSON 作为 Body 调用
  CreateFunction(Version=2024-06-06)；首次创建用 CreateFunction，更新镜像/配置用
  UpdateFunctionResource。

创建后在控制台为 fin-web 配置 APIG 触发器 + HTTPS 域名；fin-worker 保持常驻（CpuStrategy=always）。
EOF
