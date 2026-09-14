#!/usr/bin/env bash
# 在指定 Linux 部署机上构建镜像，并按 Worker -> Web 顺序发布。
set -euo pipefail

TAG="${1:?用法: release-from-deploy-host.sh <vNN> [source-dir]}"
SOURCE_DIR="${2:-$PWD}"
EXPECTED_HOST="${FINANCIAL_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
REGISTRY="${CR_REGISTRY:-docker-cr-input-cn-beijing.cr.volces.com}"
CR_INSTANCE="${CR_INSTANCE:-${REGISTRY%%-cn-*}}"
NAMESPACE="${CR_NAMESPACE:-fin}"
REPOSITORY="${CR_REPO:-financial-workbench}"
WEB_FUNCTION_ID="${FIN_WEB_FUNCTION_ID:-5gn416ub}"
WORKER_FUNCTION_ID="${FIN_WORKER_FUNCTION_ID:-a0hgmf9x}"
PUBLIC_HEALTH_URL="${FIN_PUBLIC_HEALTH_URL:-https://s0ii6ameg9bmnc9s8rrtt.apigateway-cn-beijing.volceapi.com/api/health}"
BUILD_ASSET_DIR="$SOURCE_DIR/.build-assets"
TRADINGAGENTS_ARCHIVE="$BUILD_ASSET_DIR/tradingagents-85946c2f.tar.gz"
LONGBRIDGE_NATIVE_ARCHIVE="$BUILD_ASSET_DIR/longbridge-linux-x64-gnu-4.3.2.tgz"
MAX_IMAGE_SIZE_BYTES="${FIN_MAX_IMAGE_SIZE_BYTES:-1500000000}"

if [[ "$(hostname)" != "$EXPECTED_HOST" ]]; then
  echo "拒绝发布：当前主机不是指定部署机 $EXPECTED_HOST" >&2
  exit 1
fi
if [[ ! "$TAG" =~ ^v([1-9][0-9]*)$ ]]; then
  echo "镜像标签必须为递增的 vNN，例如 v56" >&2
  exit 1
fi
GENERATION="${BASH_REMATCH[1]}"
IMAGE="$REGISTRY/$NAMESPACE/$REPOSITORY:$TAG"

for command in flock podman vefaas curl jq; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "部署机缺少命令：$command" >&2
    exit 1
  }
done
[[ -f "$SOURCE_DIR/deploy/volcano/docker/Dockerfile.vefaas" ]] || {
  echo "发布目录不完整：$SOURCE_DIR" >&2
  exit 1
}

exec 9>/var/lock/financial-workbench-release.lock
flock -n 9 || {
  echo "已有金融工作台发布任务正在执行" >&2
  exit 1
}

refresh_registry_login() {
  local auth_json=""
  local credential_json=""
  local username=""
  local token=""
  local vefaas_auth_file="${VEFAAS_AUTH_FILE:-${VEFAAS_HOME:-$HOME}/.vefaas/auth.enc}"

  if command -v ve >/dev/null 2>&1; then
    auth_json="$(
      ve cr GetAuthorizationToken \
        --Registry "$CR_INSTANCE" \
        -o json 2>/dev/null
    )" || auth_json=""
  fi

  if [[ -z "$auth_json" && -r "$vefaas_auth_file" ]] &&
     command -v node >/dev/null 2>&1 &&
     command -v ve >/dev/null 2>&1; then
    credential_json="$(
      VEFAAS_AUTH_FILE="$vefaas_auth_file" node <<'NODE'
const crypto = require('crypto')
const fs = require('fs')

const payload = JSON.parse(
  fs.readFileSync(process.env.VEFAAS_AUTH_FILE, 'utf8'),
)
const key = crypto.pbkdf2Sync(
  'vefaas-cli:credential-store:v1',
  'vefaas-cli-salt-v1',
  100_000,
  32,
  'sha256',
)
const decipher = crypto.createDecipheriv(
  'aes-256-gcm',
  key,
  Buffer.from(payload.iv, 'base64'),
  { authTagLength: 16 },
)
decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
const credentials = JSON.parse(
  Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8'),
)
process.stdout.write(JSON.stringify({
  ak: credentials.ak,
  sk: credentials.sk,
}))
NODE
    )"

    auth_json="$(
      VOLCENGINE_ACCESS_KEY="$(jq -er '.ak' <<<"$credential_json")" \
      VOLCENGINE_SECRET_KEY="$(jq -er '.sk' <<<"$credential_json")" \
      VOLCENGINE_REGION="${VOLCENGINE_REGION:-cn-beijing}" \
        ve cr GetAuthorizationToken \
          --Registry "$CR_INSTANCE" \
          -o json
    )"
  fi

  username="$(jq -er '.Result.Username' <<<"$auth_json")"
  token="$(jq -er '.Result.Token' <<<"$auth_json")"
  printf '%s' "$token" |
    podman login \
      --username "$username" \
      --password-stdin \
      "$REGISTRY" >/dev/null
  unset auth_json credential_json username token
}

cd "$SOURCE_DIR"
mkdir -p "$BUILD_ASSET_DIR"

download_and_verify() {
  local url="$1"
  local target="$2"
  local checksum_command="$3"
  local expected="$4"
  local actual=""

  if [[ -f "$target" ]]; then
    actual="$($checksum_command "$target" | awk '{print $1}')"
  fi
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$target.tmp"
    curl --fail --location --retry 3 --retry-delay 5 \
      --connect-timeout 15 --max-time 300 \
      -o "$target.tmp" "$url"
    actual="$($checksum_command "$target.tmp" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || {
      echo "构建制品校验失败：$target" >&2
      rm -f "$target.tmp"
      exit 1
    }
    mv "$target.tmp" "$target"
  fi
}

echo "[准备] 下载并校验固定版本构建制品"
download_and_verify \
  "https://codeload.github.com/TauricResearch/TradingAgents/tar.gz/85946c2f60768ab2dae23a5a36cd927662feef94" \
  "$TRADINGAGENTS_ARCHIVE" sha256sum \
  "610c58bbcdbcdce46f4f9239cee06bf27be5602db8a1e28032bacf74e11ebac5"
download_and_verify \
  "https://registry.npmjs.org/longbridge-linux-x64-gnu/-/longbridge-linux-x64-gnu-4.3.2.tgz" \
  "$LONGBRIDGE_NATIVE_ARCHIVE" sha512sum \
  "3c4328745d5e04d6946b1979fa9249b49e1997d57599ed738d32066d709616a40b814978e7b7d834bb47a52dc917f13f14dbb8f5ce9c8562e7e863a2d2bbc278"

if [[ ! -f .dockerignore ]]; then
  cp deploy/volcano/docker/.dockerignore .dockerignore
fi

available_kb="$(df --output=avail / | tail -n 1 | tr -d ' ')"
minimum_kb="$((6 * 1024 * 1024))"
if (( available_kb < minimum_kb )); then
  echo "[准备] 可用磁盘低于 6GB，清理可重新生成的 Podman 镜像和构建缓存"
  mapfile -t build_containers < <(podman ps -aq --external --filter name=working-container)
  if (( ${#build_containers[@]} > 0 )); then
    podman rm --force "${build_containers[@]}"
  fi
  podman system prune --all --force
fi

echo "[1/7] 构建镜像 $IMAGE"
podman build \
  --layers \
  --network host \
  --secret "id=tradingagents_archive,src=$TRADINGAGENTS_ARCHIVE" \
  --secret "id=longbridge_native_archive,src=$LONGBRIDGE_NATIVE_ARCHIVE" \
  --build-arg "WORKER_DEPLOYMENT_GENERATION=$GENERATION" \
  -f deploy/volcano/docker/Dockerfile.vefaas \
  -t "$IMAGE" \
  .

image_size_bytes="$(podman image inspect --format '{{.Size}}' "$IMAGE")"
echo "[门禁] 镜像未压缩大小：$image_size_bytes bytes（上限：$MAX_IMAGE_SIZE_BYTES）"
if (( image_size_bytes > MAX_IMAGE_SIZE_BYTES )); then
  echo "镜像体积超过发布上限，拒绝推送：$IMAGE" >&2
  exit 1
fi
podman run --rm --entrypoint bash "$IMAGE" -lc '
  test ! -e /app/.build-assets
  test ! -e /tmp/build-assets
  test ! -d /app/node_modules/vite
  node -e "require(\"longbridge\")"
  /app/.venv-tradingagents/bin/python -c "import tradingagents"
'

echo "[2/7] 刷新 CR 登录并推送镜像"
refresh_registry_login
podman push "$IMAGE"

wait_release() {
  local function_id="$1"
  local label="$2"
  for _ in $(seq 1 80); do
    local status
    status="$(vefaas fn info --id "$function_id" -o json --jq '.data.ReleaseStatus.status' -r)"
    if [[ "$status" == "done" ]]; then
      echo "$label 发布完成"
      return 0
    fi
    if [[ "$status" == "failed" || "$status" == "aborted" ]]; then
      echo "$label 发布失败：$status" >&2
      return 1
    fi
    sleep 5
  done
  echo "$label 发布状态等待超时" >&2
  return 1
}

echo "[3/7] 更新 Worker 镜像和发布代际"
vefaas fn env unset WORKER_DEPLOYMENT_GENERATION \
  --id "$WORKER_FUNCTION_ID" -y -o json >/dev/null
vefaas fn config --id "$WORKER_FUNCTION_ID" \
  --source "$IMAGE" --sourceType image -y -o json >/dev/null

echo "[4/7] 发布 Worker"
vefaas fn release --id "$WORKER_FUNCTION_ID" \
  --description "$TAG worker" -y -o json >/dev/null
wait_release "$WORKER_FUNCTION_ID" "Worker"

echo "[5/7] 更新并发布 Web"
vefaas fn config --id "$WEB_FUNCTION_ID" \
  --source "$IMAGE" --sourceType image -y -o json >/dev/null
vefaas fn release --id "$WEB_FUNCTION_ID" \
  --description "$TAG web" -y -o json >/dev/null
wait_release "$WEB_FUNCTION_ID" "Web"

echo "[6/7] 检查线上健康状态"
curl --fail --silent --show-error --retry 12 --retry-delay 5 "$PUBLIC_HEALTH_URL" >/dev/null

echo "[7/7] 发布完成"
vefaas fn info --id "$WORKER_FUNCTION_ID" -o json \
  --jq '.data | {Name,CurrentRevision,Source,Status}'
vefaas fn info --id "$WEB_FUNCTION_ID" -o json \
  --jq '.data | {Name,CurrentRevision,Source,Status}'
