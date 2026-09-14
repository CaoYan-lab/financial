#!/usr/bin/env bash
# 云上/容器环境拉取并安装 TradingAgents（A 股 LLM 多智能体决策链路依赖）。
#
# 背景：third_party/ 与 .venv* 被 .gitignore 忽略，不随仓库/镜像分发；
#       本脚本在镜像构建期（Dockerfile RUN）或 worker/ECS 首次启动时执行，
#       按 deploy/volcano/tradingagents/VERSION 锁定的 commit 拉取，保证版本可复现。
#
# 用法：
#   bash deploy/volcano/scripts/fetch-tradingagents.sh
# 可覆盖变量：
#   TRADINGAGENTS_REPO_PATH  目标目录（默认 <项目根>/third_party/TradingAgents）
#   TRADINGAGENTS_VENV       独立 venv 目录（默认 <项目根>/.venv-tradingagents）
#   PYTHON_BIN               用于建 venv 的解释器（默认 python3，需 >=3.10）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VERSION_FILE="$SCRIPT_DIR/../tradingagents/VERSION"

# shellcheck disable=SC1090
REPO_URL="$(grep '^REPO_URL=' "$VERSION_FILE" | cut -d= -f2-)"
PINNED_COMMIT="$(grep '^PINNED_COMMIT=' "$VERSION_FILE" | cut -d= -f2-)"
PINNED_TAG="$(grep '^PINNED_TAG=' "$VERSION_FILE" | cut -d= -f2-)"

REPO_PATH="${TRADINGAGENTS_REPO_PATH:-$PROJECT_ROOT/third_party/TradingAgents}"
VENV_DIR="${TRADINGAGENTS_VENV:-$PROJECT_ROOT/.venv-tradingagents}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
ARCHIVE="${TRADINGAGENTS_ARCHIVE:-}"

echo "[fetch-tradingagents] 项目根: $PROJECT_ROOT"
echo "[fetch-tradingagents] 目标仓库: $REPO_PATH"
echo "[fetch-tradingagents] 版本锁定: $PINNED_TAG ($PINNED_COMMIT)"

# 1) 优先使用发布机已校验并放入构建上下文的源码归档。
if [ -n "$ARCHIVE" ] && [ -r "$ARCHIVE" ]; then
  echo "[fetch-tradingagents] 使用固定提交源码归档: $ARCHIVE"
  rm -rf "$REPO_PATH"
  mkdir -p "$REPO_PATH"
  tar -xzf "$ARCHIVE" --strip-components=1 -C "$REPO_PATH"
elif [ -d "$REPO_PATH/.git" ]; then
  echo "[fetch-tradingagents] 仓库已存在，校验 commit..."
  CURRENT="$(git -C "$REPO_PATH" rev-parse HEAD)"
  if [ "$CURRENT" != "$PINNED_COMMIT" ]; then
    echo "[fetch-tradingagents] 当前 $CURRENT，切到锁定版本..."
    git -C "$REPO_PATH" fetch --depth 1 origin "$PINNED_COMMIT"
    git -C "$REPO_PATH" checkout --quiet "$PINNED_COMMIT"
  fi
else
  mkdir -p "$(dirname "$REPO_PATH")"
  echo "[fetch-tradingagents] 克隆仓库（浅克隆到锁定 commit）..."
  rm -rf "$REPO_PATH"
  git init -q "$REPO_PATH"
  git -C "$REPO_PATH" remote add origin "$REPO_URL"
  if git -C "$REPO_PATH" fetch --depth 1 origin "$PINNED_COMMIT"; then
    git -C "$REPO_PATH" checkout --quiet FETCH_HEAD
  else
    echo "[fetch-tradingagents] Git 拉取失败，改用固定提交源码归档..." >&2
    rm -rf "$REPO_PATH"
    mkdir -p "$REPO_PATH"
    if ! curl --fail --location \
      --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 180 \
      "https://codeload.github.com/TauricResearch/TradingAgents/tar.gz/$PINNED_COMMIT" |
      tar -xz --strip-components=1 -C "$REPO_PATH"; then
      echo "[fetch-tradingagents] 拉取失败，拒绝构建缺少报告依赖的镜像" >&2
      exit 1
    fi
  fi
fi

# 2) 创建独立 venv（Python >= 3.10）
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "[fetch-tradingagents] 创建 venv: $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
"$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null

# 3) 安装 TradingAgents 及其依赖（按 pyproject.toml）
echo "[fetch-tradingagents] 安装 tradingagents（pip install .）..."
"$VENV_DIR/bin/python" -m pip install "$REPO_PATH"

# 4) 自检
"$VENV_DIR/bin/python" - <<'PY'
import sys
import tradingagents  # noqa: F401
print(f"[fetch-tradingagents] 自检通过: tradingagents 可用, Python {sys.version.split()[0]}")
PY

cat <<EOF

[fetch-tradingagents] 完成。云环境请配置：
  TRADINGAGENTS_REPO_PATH=$REPO_PATH
  TRADINGAGENTS_PYTHON_BIN=$VENV_DIR/bin/python
EOF
