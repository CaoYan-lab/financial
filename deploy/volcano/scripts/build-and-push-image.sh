#!/usr/bin/env bash
# 构建并推送 veFaaS 单镜像到火山 CR。
# 用法（在仓库根目录）：
#   CR_REGISTRY=finreg-cn-beijing.cr.volces.com CR_NAMESPACE=fin \
#   CR_USER=<账号名@账号ID> bash deploy/volcano/scripts/build-and-push-image.sh [tag]
#
# 前置：已 docker login 到 CR（或用控制台“获取临时访问指令”，1 小时有效）：
#   docker login --username=<User>@<UserID> finreg-cn-beijing.cr.volces.com
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT_ROOT"

CR_REGISTRY="${CR_REGISTRY:?需设置 CR_REGISTRY，如 finreg-cn-beijing.cr.volces.com}"
CR_NAMESPACE="${CR_NAMESPACE:-fin}"
REPO="${CR_REPO:-financial-workbench}"
TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMAGE="${CR_REGISTRY}/${CR_NAMESPACE}/${REPO}:${TAG}"

echo "[build] 项目根: $PROJECT_ROOT"
echo "[build] 目标镜像: $IMAGE"

# Docker 固定读取构建上下文根的 .dockerignore（排除 .data/.venv/密钥等，见 deploy/volcano/docker/.dockerignore）
if [ ! -f "$PROJECT_ROOT/.dockerignore" ]; then
  cp deploy/volcano/docker/.dockerignore "$PROJECT_ROOT/.dockerignore"
  echo "[build] 已从 deploy/volcano/docker/.dockerignore 生成根 .dockerignore"
fi

docker build \
  -f deploy/volcano/docker/Dockerfile.vefaas \
  -t "$IMAGE" \
  .

echo "[build] 推送镜像..."
docker push "$IMAGE"

cat <<EOF

✅ 镜像已推送：$IMAGE

veFaaS 配置：
- Web 函数启动命令：  bash deploy/volcano/faas/run-web.sh
- Worker 函数启动命令：bash deploy/volcano/faas/run-worker.sh
- 监听端口：8000
EOF
