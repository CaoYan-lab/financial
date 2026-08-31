# Financial Linux 裸机部署与打包方案

本文档用于将 `Financial` 工程部署到公网 Linux 云主机，采用 `PM2 + Nginx` 的裸机部署方式，并覆盖 Futu / Longbridge 真实交易能力的准备、门禁、验收和回滚。

## 1. 当前工程形态

- 前端：React + Vite + TypeScript，源码在 `src/`，构建产物在 `dist/`。
- 后端：Express + TypeScript，源码在 `api/`，服务入口为 `api/server.ts`。
- API 健康检查：`/api/health`。
- 前端开发代理：`vite.config.ts` 将 `/api` 代理到 `http://localhost:3001`。
- 当前 `tsconfig.json` 设置了 `noEmit: true`，后端没有独立 JS 编译产物；生产部署使用 PM2 托管 `tsx api/server.ts`。
- `api/app.ts` 不服务 `dist/`，生产前端静态资源由 Nginx 直接服务。

关键脚本：

```bash
npm ci
npm run check
npm run lint
npm run test
npm run build
```

## 2. 推荐生产架构

```text
User Browser
  |
  | HTTPS 443
  v
Nginx
  |-- /                  -> /opt/financial/current/dist
  |-- /api/*             -> http://127.0.0.1:3001/api/*
                              |
                              v
                          PM2 financial-api
                              |
                              | spawn
                              v
                         Python bridge / Futu OpenD / Longbridge CLI
```

生产约束：

- 只对公网开放 `80/443`。
- 不对公网开放 `3001`。
- 不对公网开放 Futu OpenD 端口 `11111`。
- API 单实例运行，避免 SQLite 多进程写入风险。
- `.data/` 是生产持久化目录，发布时不能覆盖。

## 3. 服务器准备

建议环境：

- Ubuntu 22.04 LTS 或 24.04 LTS。
- CPU：2 核起步；真实行情订阅、LLM 并发和 TradingAgents 建议 4 核以上。
- 内存：4GB 起步；真实交易和 TradingAgents 建议 8GB 以上。
- 磁盘：50GB 起步，并为 `.data`、PM2 log、Nginx log 预留增长空间。

基础包：

```bash
sudo apt update
sudo apt install -y \
  curl git build-essential \
  python3 python3-venv python3-pip \
  nginx logrotate
```

Node.js 建议使用 Node.js 22 LTS：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

PM2：

```bash
sudo npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## 4. 目录规划

推荐统一放在 `/opt/financial`：

```text
/opt/financial/
  releases/
    20260713-001/
  current -> /opt/financial/releases/20260713-001
  shared/
    .env
    .data/
    .futu-home/
    logs/
  venvs/
    futu/
    tradingagents/
```

初始化：

```bash
sudo mkdir -p /opt/financial/releases /opt/financial/shared/.data /opt/financial/shared/.futu-home /opt/financial/shared/logs /opt/financial/venvs
sudo chown -R $USER:$USER /opt/financial
```

发布规则：

- 每次发布创建新的 `/opt/financial/releases/<version>`。
- `/opt/financial/current` 指向当前版本。
- `.env`、`.data`、`.futu-home` 始终放在 `shared/`。
- release 内通过软链引用共享目录。

## 5. 环境变量

生产环境文件建议放在 `/opt/financial/shared/.env`。当前工程按部署要求允许 `.env` / `.env.local` 上传到 Git；提交前必须确认仓库权限、访问范围和密钥轮换策略。

基础服务：

```bash
NODE_ENV=production
PORT=3001
LOG_LEVEL=info
LOG_PRETTY=false
```

Futu：

```bash
FUTU_PYTHON_BIN=/opt/financial/venvs/futu/bin/python
FUTU_BRIDGE_HOME=/opt/financial/shared/.futu-home
FUTU_OPEND_HOST=127.0.0.1
FUTU_OPEND_PORT=11111
FUTU_ENABLE_OPTIONS=true
FUTU_ENABLE_TECHNICALS=true

# 真实交易门禁，首轮生产建议保持关闭
LIVE_TRADING_ENABLED=false
FUTU_LIVE_TRD_ENV=REAL
FUTU_AUTO_SUBMIT_ENABLED=false
```

Longbridge：

```bash
LONGBRIDGE_CLI_BIN=/usr/local/bin/longbridge
LONGBRIDGE_APP_KEY=...
LONGBRIDGE_APP_SECRET=...
LONGBRIDGE_ACCESS_TOKEN=...

# 真实交易门禁，首轮生产建议保持关闭
LONGBRIDGE_LIVE_TRADING_ENABLED=false
LONGBRIDGE_AUTO_SUBMIT_ENABLED=false
```

LLM / 搜索：

```bash
ARK_API_KEY=...
ARK_MODEL=deepseek-v4
ARK_RESPONSES_URL=https://ark.cn-beijing.volces.com/api/v3/responses
GLM_API_KEY=...
GLM_MODEL=glm-5.2
DOUBAO_SEARCH_API_KEY=...
SEARCH_INFINITY_API_KEY=...
```

SQLite 持久化路径：

```bash
REPORT_HISTORY_DB_PATH=/opt/financial/shared/.data/top30-report-history.sqlite3
SIMULATION_HISTORY_DB_PATH=/opt/financial/shared/.data/simulation-history.sqlite3
LIVE_TRADING_HISTORY_DB_PATH=/opt/financial/shared/.data/live-trading-history.sqlite3
ASHARE_LIVE_HISTORY_DB_PATH=/opt/financial/shared/.data/a-share-live-history.sqlite3
```

A 股 / TradingAgents：

```bash
TRADINGAGENTS_REPO_PATH=/opt/financial/current/third_party/TradingAgents
TRADINGAGENTS_PYTHON_BIN=/opt/financial/venvs/tradingagents/bin/python
TRADINGAGENTS_OUTPUT_LANGUAGE=Chinese
ASHARE_LOT_SIZE=100
ASHARE_MAX_SINGLE_ORDER_NOTIONAL=50000
ASHARE_MAX_POSITION_RATIO=0.2
ASHARE_ESTIMATED_FEE_RATE=0.001
```

## 6. 打包方案

### 6.0 Git 提交与推送

部署前先把本次代码、文档和环境变量变更提交到远端仓库，服务器发布时再拉取指定 commit。

检查变更：

```bash
git status --short
git diff -- .gitignore docs/linux-pm2-nginx-deployment.md .env .env.local
```

如需提交 `.env` 或 `.env.local`，先确认 `.gitignore` 已允许跟踪：

```bash
git check-ignore -v .env || true
git check-ignore -v .env.local || true
```

添加文件：

```bash
git add .gitignore docs/linux-pm2-nginx-deployment.md
git add .env .env.local
```

提交：

```bash
git commit -m "docs: add linux deployment guide"
```

推送当前分支：

```bash
git branch --show-current
git push origin <branch-name>
```

记录本次发布 commit：

```bash
git rev-parse HEAD
```

服务器部署时使用该 commit：

```bash
git checkout <commit-sha>
```

### 6.1 推荐：服务器拉代码构建

本方案最适合当前工程，因为后端生产启动依赖 TypeScript 源码和 `tsx`，且不能从 macOS 复制 `node_modules` 到 Linux。

本地或 CI 先做质量检查：

```bash
npm ci
npm run check
npm run lint
npm run test
npm run build
```

服务器发布：

```bash
VERSION=20260713-001
RELEASE_DIR=/opt/financial/releases/$VERSION

mkdir -p "$RELEASE_DIR"
git clone <your-git-repo-url> "$RELEASE_DIR"
cd "$RELEASE_DIR"
git checkout <commit-sha>

ln -sfn /opt/financial/shared/.env .env
ln -sfn /opt/financial/shared/.data .data
ln -sfn /opt/financial/shared/.futu-home .futu-home

npm ci
npm run check
npm run lint
npm run test
npm run build
```

切换当前版本：

```bash
ln -sfn "$RELEASE_DIR" /opt/financial/current
```

### 6.2 备选：本地生成源码包

```bash
tar \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.data \
  --exclude=.logs \
  --exclude=.futu-home \
  -czf financial-release-<version>.tar.gz .
```

上传到服务器后仍然需要在 Linux 上执行：

```bash
npm ci
npm run build
```

## 7. Python 与交易依赖

### 7.1 Futu Python SDK

```bash
python3 -m venv /opt/financial/venvs/futu
/opt/financial/venvs/futu/bin/pip install --upgrade pip
/opt/financial/venvs/futu/bin/pip install futu-api
```

校验：

```bash
/opt/financial/venvs/futu/bin/python -c "import futu; print('futu-api ok')"
```

### 7.2 TradingAgents

```bash
python3 -m venv /opt/financial/venvs/tradingagents
/opt/financial/venvs/tradingagents/bin/pip install --upgrade pip
/opt/financial/venvs/tradingagents/bin/pip install -r /opt/financial/current/third_party/TradingAgents/requirements.txt
```

### 7.3 Futu OpenD

准备项：

- 安装 Linux 版本 Futu OpenD 或确认可在服务器稳定运行。
- 登录交易账户。
- 开启 OpenAPI 访问。
- 确认监听 `127.0.0.1:11111`。
- 真实交易前完成交易解锁流程。
- 不要将 `11111` 暴露到公网。

Futu OpenD 和 `futu-api` Python SDK 是两个不同依赖，二者都需要准备。

### 7.4 Longbridge

准备项：

- 安装 Longbridge CLI。
- 配置 `LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN`。
- 用 CLI 校验登录状态。
- 首轮生产保持 `LONGBRIDGE_LIVE_TRADING_ENABLED=false`。

## 8. PM2 托管 API

在 `/opt/financial/current/ecosystem.config.cjs` 或任意受控位置准备：

```js
module.exports = {
  apps: [
    {
      name: 'financial-api',
      cwd: '/opt/financial/current',
      script: './node_modules/.bin/tsx',
      args: 'api/server.ts',
      env_file: '/opt/financial/shared/.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      out_file: '/opt/financial/shared/logs/api-out.log',
      error_file: '/opt/financial/shared/logs/api-error.log',
      time: true,
    },
  ],
}
```

启动：

```bash
cd /opt/financial/current
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

后续发布重载：

```bash
pm2 reload financial-api --update-env
```

## 9. Nginx 配置

示例文件：`/etc/nginx/sites-available/financial.conf`

```nginx
server {
    listen 80;
    server_name financial.example.com;

    root /opt/financial/current/dist;
    index index.html;

    client_max_body_size 10m;

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

启用：

```bash
sudo ln -sfn /etc/nginx/sites-available/financial.conf /etc/nginx/sites-enabled/financial.conf
sudo nginx -t
sudo systemctl reload nginx
```

HTTPS 建议使用 Certbot 或云厂商证书；上线真实账户前必须启用 HTTPS。

## 10. 发布流程

1. 确认本地或 CI 通过：

```bash
npm run check
npm run lint
npm run test
npm run build
```

2. 提交并推送本次变更：

```bash
git status --short
git add .gitignore docs/linux-pm2-nginx-deployment.md .env .env.local
git commit -m "deploy: prepare linux release"
git push origin <branch-name>
git rev-parse HEAD
```

3. 在服务器创建 release 并拉取指定 commit。
4. 软链 `.env`、`.data`、`.futu-home`。如果 `.env` 已随代码仓库上传，也建议在服务器上复核后同步到 `/opt/financial/shared/.env`。
5. 执行 `npm ci` 和 `npm run build`。
6. 切换 `/opt/financial/current`。
7. 重载 API：

```bash
pm2 reload financial-api --update-env
```

8. 重载 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

9. 执行验收清单。

## 11. 验收清单

基础服务：

```bash
curl -f http://127.0.0.1:3001/api/health
curl -I http://financial.example.com/
curl -f http://financial.example.com/api/health
pm2 status
pm2 logs financial-api --lines 100
```

市场数据与交易源：

```bash
curl -s http://127.0.0.1:3001/api/source/status
curl -s http://127.0.0.1:3001/api/a-share/dashboard
curl -s http://127.0.0.1:3001/api/longbridge/status
curl -s http://127.0.0.1:3001/api/longbridge/live-trading/dashboard
```

页面检查：

- 首页可访问。
- 平台入口可打开。
- A 股工作台可加载。
- Futu 实盘页面可加载账户、持仓、订单状态。
- Longbridge 实盘页面可加载授权状态和候选池。
- 历史记录分页正常。

持久化检查：

- API 重启后历史数据仍存在。
- 新 release 发布后 `.data/*.sqlite3` 没有被覆盖。
- `.env` / `.env.local` 如已进入代码仓库或发布包，确认远端仓库权限受控且密钥内容与目标环境匹配。

## 12. 真实交易前置检查

真实交易能力可以部署，但建议首轮生产默认关闭自动提交。

Futu 真实交易开启前必须确认：

- `LIVE_TRADING_ENABLED=true`。
- `FUTU_LIVE_TRD_ENV=REAL`。
- `FUTU_AUTO_SUBMIT_ENABLED=false` 作为首轮默认值，人工确认稳定后再评估是否开启。
- Futu OpenD 已登录真实账户并完成交易解锁。
- `FUTU_OPEND_HOST` 和 `FUTU_OPEND_PORT` 指向正确实例。
- A 股规则仍生效：禁止卖空、连续竞价时段外不下单、100 股整数手、平仓必须有多头持仓。

Longbridge 真实交易开启前必须确认：

- `LONGBRIDGE_LIVE_TRADING_ENABLED=true`。
- `LONGBRIDGE_AUTO_SUBMIT_ENABLED=false` 作为首轮默认值。
- Longbridge CLI / SDK 凭证有效。
- 账户、币种、市场权限和下单权限已经核对。

建议首笔真实交易：

- 使用最小金额或最小股数。
- 保持人工确认。
- 观察 PM2 日志、交易页面、券商端订单状态三处一致后再扩大使用。

## 13. 日志、备份与回滚

### 13.1 日志

- PM2 日志放在 `/opt/financial/shared/logs/`。
- PM2 使用 `pm2-logrotate` 限制单文件大小和保留天数。
- Nginx 使用系统 logrotate。
- 生产默认 `LOG_LEVEL=info`、`LOG_PRETTY=false`。
- 如需排查大 payload，只临时提升日志级别，排查后立即恢复。

### 13.2 备份

建议每天备份：

```bash
BACKUP_DIR=/opt/financial/backups/$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR"
cp /opt/financial/shared/.data/*.sqlite3 "$BACKUP_DIR"/
cp /opt/financial/shared/.env "$BACKUP_DIR"/.env
```

注意：

- `.env` 含敏感信息，备份目录必须限制权限。
- 发布前单独备份 `.data` 中关键 DB。
- 不要把 `.data` 打进 release 包覆盖生产数据。

### 13.3 回滚

```bash
PREVIOUS=/opt/financial/releases/<previous-version>

ln -sfn "$PREVIOUS" /opt/financial/current
pm2 reload financial-api --update-env
sudo nginx -t
sudo systemctl reload nginx
curl -f http://127.0.0.1:3001/api/health
```

如果数据结构未变，回滚只需切换 `current`。如果后续引入数据库迁移，必须在发布文档中增加迁移和回滚策略。

## 14. 已知限制与后续优化

当前限制：

- 后端生产以 `tsx api/server.ts` 运行，依赖 TypeScript 源码和 `tsx`。
- `api/app.ts` 当前不服务 `dist/`，Nginx 是生产必需组件。
- Futu bridge 中有 macOS user site 兜底路径，Linux 生产必须显式设置 `FUTU_PYTHON_BIN`，必要时设置 `PYTHONPATH`。
- SQLite 是单机本地持久化，不适合多实例 API 水平扩容。

建议后续优化：

- 增加 `tsconfig.server.json`，将后端编译到 `api-dist/`。
- 增加 `npm run server:build` 和 `npm run server:start`。
- 将 `ecosystem.config.cjs` 纳入仓库。
- 新增 `.env.example`，按生产变量分组但不包含密钥。
- 新增发布脚本和健康检查脚本。
- 如需多实例或容灾，将 SQLite 迁移到托管数据库。
