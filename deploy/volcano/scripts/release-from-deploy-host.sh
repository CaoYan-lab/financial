#!/usr/bin/env bash
# 在指定 Linux 部署机上构建镜像，并按 Worker -> Web 顺序发布。
set -euo pipefail

TAG="${1:?用法: release-from-deploy-host.sh <vNN> [source-dir]}"
SOURCE_DIR="${2:-$PWD}"
EXPECTED_HOST="${FINANCIAL_DEPLOY_HOSTNAME:-ECS-0EJj-deploy}"
REGISTRY="${CR_REGISTRY:-docker-cr-input-cn-beijing.cr.volces.com}"
NAMESPACE="${CR_NAMESPACE:-fin}"
REPOSITORY="${CR_REPO:-financial-workbench}"
WEB_FUNCTION_ID="${FIN_WEB_FUNCTION_ID:-5gn416ub}"
WORKER_FUNCTION_ID="${FIN_WORKER_FUNCTION_ID:-a0hgmf9x}"
PUBLIC_HEALTH_URL="${FIN_PUBLIC_HEALTH_URL:-https://s0ii6ameg9bmnc9s8rrtt.apigateway-cn-beijing.volceapi.com/api/health}"

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

cd "$SOURCE_DIR"
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
podman build --layers -f deploy/volcano/docker/Dockerfile.vefaas -t "$IMAGE" .

echo "[2/7] 推送镜像"
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
vefaas fn config --id "$WORKER_FUNCTION_ID" \
  --source "$IMAGE" --sourceType image -y -o json >/dev/null
vefaas fn env set "WORKER_DEPLOYMENT_GENERATION=$GENERATION" \
  --id "$WORKER_FUNCTION_ID" -y -o json >/dev/null

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
