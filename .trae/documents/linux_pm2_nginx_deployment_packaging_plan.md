# Financial Linux 裸机部署与打包方案文档设计

## Summary

目标是为 `Financial` 工程设计一份可执行的 Linux 服务器部署文档，覆盖从本地/CI 打包、服务器准备、裸机部署、PM2 进程托管、Nginx 反向代理、真实交易能力接入，到验收、监控、备份与回滚的完整流程。

本方案按用户已确认的前提设计：

- 目标环境：公网 Linux 云主机。
- 部署方式：裸机 `PM2 + Nginx`。
- 业务范围：包含真实交易能力，需覆盖 Futu 与 Longbridge 的凭证、OpenD/CLI、门禁和风控检查。

## Current State Analysis

### 工程形态

- 前端：`src/` 下的 React + Vite + TypeScript 工程。
- 后端：`api/` 下的 Express + TypeScript API 服务。
- API 入口：
  - 本地/服务进程入口：`api/server.ts`。
  - Vercel serverless 入口：`api/index.ts`。
- 应用组装：`api/app.ts`，加载 `.env.local` / `.env`，注册 `/api/*` 路由和 `/api/health`。
- 前端开发代理：`vite.config.ts` 将 `/api` 代理到 `http://localhost:3001`。
- 当前生产前端产物：`dist/`，由 `npm run build` 生成。
- 当前后端无 JS 编译产物：`tsconfig.json` 设置了 `noEmit: true`，因此裸机生产启动建议使用 `tsx api/server.ts`，由 PM2 托管。

### 当前脚本

来自 `package.json`：

- `npm run build`：执行 `tsc -b && vite build`，用于类型检查和前端打包。
- `npm run check`：执行 `tsc --noEmit`。
- `npm run lint`：执行 `eslint .`。
- `npm run test`：执行 `vitest run`。
- `npm run server:dev`：通过 `nodemon` 启动 `tsx api/server.ts`。
- `npm run dev`：同时启动前端 Vite 和后端 dev server，仅用于开发。

### 运行依赖

- Node.js 运行时：项目依赖 `tsx`、Express、Vite、React、Longbridge SDK/CLI 相关包。
- Python 运行时：
  - `api/futu_bridge/*.py` 依赖 `futu-api` Python SDK 和标准库 `sqlite3`。
  - `third_party/TradingAgents` 包含 `requirements.txt`、`pyproject.toml`、`Dockerfile` 和 `docker-compose.yml`，A 股 TradingAgents bridge 会通过 `TRADINGAGENTS_REPO_PATH` / `TRADINGAGENTS_PYTHON_BIN` 接入。
- Futu OpenD：后端默认连接 `FUTU_OPEND_HOST=127.0.0.1`、`FUTU_OPEND_PORT=11111`。
- Longbridge：
  - SDK 环境变量：`LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN`。
  - CLI 可通过 `LONGBRIDGE_CLI_BIN` 指定。

### 数据与状态

项目默认使用 `.data/` 保存本地状态和 SQLite 数据：

- `.data/a-share-live-config.json`
- `.data/a-share-universe.json`
- `.data/a-share-live-history.sqlite3`
- `.data/live-trading-history.sqlite3`
- `.data/simulation-history.sqlite3`
- `.data/top30-report-history.sqlite3`

可通过环境变量改写部分路径：

- `REPORT_HISTORY_DB_PATH`
- `SIMULATION_HISTORY_DB_PATH`
- `LIVE_TRADING_HISTORY_DB_PATH`
- `ASHARE_LIVE_HISTORY_DB_PATH`

部署文档应明确：`.data/` 是生产持久化目录，不能随发布覆盖；发布包应包含目录结构或迁移步骤，但不能覆盖生产 DB。

### 日志风险

历史运行中曾出现日志超过 5GB 导致服务被系统终止的问题。部署文档必须要求：

- PM2 日志开启轮转。
- Nginx access log 配置按日切割或接入系统 logrotate。
- 后端使用 `LOG_LEVEL=info` 或更严格级别；调试大 payload 时必须临时开启并及时关闭。

### 真实交易安全门禁

代码中已存在真实交易门禁：

- Futu 实盘提交：
  - `LIVE_TRADING_ENABLED=true`
  - `FUTU_LIVE_TRD_ENV=REAL`
- Longbridge 实盘提交：
  - `LONGBRIDGE_LIVE_TRADING_ENABLED=true`
- 自动提交开关：
  - `FUTU_AUTO_SUBMIT_ENABLED`
  - `LONGBRIDGE_AUTO_SUBMIT_ENABLED`
- A 股风控约束已在项目规则中明确：禁止 `SELL_SHORT`、非连续竞价时段拦截、100 股整数手、平仓必须有多头持仓。

文档应默认建议“先部署真实交易能力但关闭自动提交”，验收后再按确认流程开启。

## Proposed Changes

本次只设计文档，不改动运行代码。建议后续新增一份正式部署文档：

### 1. 新增部署文档

建议文件：`docs/linux-pm2-nginx-deployment.md`

用途：作为 Linux 生产部署 runbook，包含以下章节。

#### 1.1 部署目标与架构

说明生产拓扑：

- Nginx 监听 `80/443`。
- 静态前端：Nginx 直接服务 `dist/`。
- API：Nginx 将 `/api/` 反代到 `127.0.0.1:3001`。
- PM2 托管 API：`tsx api/server.ts`。
- Futu OpenD：建议与 API 同机运行，监听本机 `127.0.0.1:11111`；如分机部署，必须限制安全组来源 IP。
- Python bridge：由 Node API 按需 `spawn`。
- SQLite 与配置：生产持久化在 `/opt/financial/shared/.data`，通过软链或环境变量挂载到当前 release。

#### 1.2 服务器准备清单

覆盖：

- 操作系统：Ubuntu 22.04 LTS 或 24.04 LTS。
- 基础规格建议：
  - CPU：2 核起步，真实行情订阅和 LLM 并发建议 4 核以上。
  - 内存：4GB 起步，真实交易和 TradingAgents 建议 8GB 以上。
  - 磁盘：50GB 起步，`.data`、PM2 log、Nginx log 单独评估增长。
- 系统包：
  - `curl`、`git`、`build-essential`、`python3`、`python3-venv`、`python3-pip`、`nginx`、`logrotate`。
- Node.js：
  - 建议 Node.js 22 LTS，与当前 `@types/node` 版本保持一致。
  - 使用 `nvm` 或 NodeSource 安装。
- 进程管理：
  - 全局安装 `pm2`。
  - 安装并配置 `pm2-logrotate`。
- Python：
  - 为 Futu bridge 创建独立虚拟环境，例如 `/opt/financial/venvs/futu`。
  - 为 TradingAgents 创建独立虚拟环境，例如 `/opt/financial/venvs/tradingagents`。
- 网络：
  - 对外开放 `80/443`。
  - 不对公网开放 `3001` 和 `11111`。
  - Futu OpenD 若跨机访问，仅允许 API 服务器内网 IP。

#### 1.3 目录规划

建议生产目录：

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

规则：

- 每次发布新建 `releases/<timestamp>`。
- `current` 软链指向当前版本。
- `.env`、`.data`、`.futu-home` 放在 `shared/`，发布时软链到 release。
- 回滚只切换 `current` 软链并重启 PM2。

#### 1.4 环境变量模板

建议文档提供 `/opt/financial/shared/.env` 模板，按敏感程度分组。

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

持久化路径：

```bash
REPORT_HISTORY_DB_PATH=/opt/financial/shared/.data/top30-report-history.sqlite3
SIMULATION_HISTORY_DB_PATH=/opt/financial/shared/.data/simulation-history.sqlite3
LIVE_TRADING_HISTORY_DB_PATH=/opt/financial/shared/.data/live-trading-history.sqlite3
ASHARE_LIVE_HISTORY_DB_PATH=/opt/financial/shared/.data/a-share-live-history.sqlite3
```

A 股/TradingAgents：

```bash
TRADINGAGENTS_REPO_PATH=/opt/financial/current/third_party/TradingAgents
TRADINGAGENTS_PYTHON_BIN=/opt/financial/venvs/tradingagents/bin/python
TRADINGAGENTS_OUTPUT_LANGUAGE=Chinese
ASHARE_LOT_SIZE=100
ASHARE_MAX_SINGLE_ORDER_NOTIONAL=50000
ASHARE_MAX_POSITION_RATIO=0.2
ASHARE_ESTIMATED_FEE_RATE=0.001
```

#### 1.5 打包方案

推荐“服务器拉代码构建”作为初版裸机方案：

1. 本地或 CI 完成检查：

```bash
npm ci
npm run check
npm run lint
npm run test
npm run build
```

2. 服务器发布目录拉取指定 Git commit。
3. 服务器执行：

```bash
npm ci
npm run build
```

原因：

- 当前项目没有后端 JS emit，生产 API 仍需通过 `tsx` 读取 TypeScript 源码。
- `node_modules` 不应从 macOS 打包复制到 Linux，避免原生依赖平台不匹配。
- 前端 `dist/` 可在服务器构建，也可由 CI 构建后上传；初版用服务器构建最少改动。

备选“本地生成源码包”：

```bash
tar \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=.env.local \
  --exclude=.data \
  --exclude=.logs \
  --exclude=.futu-home \
  -czf financial-release-<version>.tar.gz .
```

上传后在服务器执行 `npm ci && npm run build`。

#### 1.6 Python 依赖安装

Futu bridge：

```bash
python3 -m venv /opt/financial/venvs/futu
/opt/financial/venvs/futu/bin/pip install --upgrade pip
/opt/financial/venvs/futu/bin/pip install futu-api
```

TradingAgents：

```bash
python3 -m venv /opt/financial/venvs/tradingagents
/opt/financial/venvs/tradingagents/bin/pip install --upgrade pip
/opt/financial/venvs/tradingagents/bin/pip install -r /opt/financial/current/third_party/TradingAgents/requirements.txt
```

文档需强调：Futu OpenD 客户端本身不等同于 `futu-api` Python SDK，二者都要准备。

#### 1.7 PM2 配置

建议新增或在文档中给出 `ecosystem.config.cjs` 示例：

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
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

#### 1.8 Nginx 配置

建议配置：

- `/` 服务 `/opt/financial/current/dist`。
- `/api/` 反代 `http://127.0.0.1:3001`。
- SPA history fallback 到 `/index.html`。
- HTTPS 通过 Certbot 或云厂商证书接入。

示例：

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

#### 1.9 Futu OpenD 准备

文档应覆盖：

- 安装 Linux 版本 Futu OpenD 或确认运行方式。
- 登录交易账户。
- 开启 API 访问。
- 确认监听地址和端口。
- 对真实交易账户启用交易解锁流程。
- 对外网络只允许必要连接，不开放 OpenD 端口到公网。

验收命令：

```bash
curl -s http://127.0.0.1:3001/api/source/status
curl -s http://127.0.0.1:3001/api/a-share/dashboard
```

#### 1.10 Longbridge 准备

文档应覆盖：

- 安装 Longbridge CLI。
- 配置 `LONGBRIDGE_APP_KEY`、`LONGBRIDGE_APP_SECRET`、`LONGBRIDGE_ACCESS_TOKEN`。
- 验证 CLI 登录状态。
- 生产默认 `LONGBRIDGE_LIVE_TRADING_ENABLED=false`，验收后再打开。

验收接口：

```bash
curl -s http://127.0.0.1:3001/api/longbridge/status
curl -s http://127.0.0.1:3001/api/longbridge/live-trading/dashboard
```

#### 1.11 发布流程

建议流程：

1. 本地/CI 记录 commit hash。
2. 在服务器创建 release 目录。
3. 拉取代码或解压源码包。
4. 软链 `.env`、`.data`、`.futu-home`。
5. `npm ci`。
6. `npm run check && npm run lint && npm run test && npm run build`。
7. 切换 `current` 软链。
8. `pm2 reload financial-api --update-env`。
9. `nginx -t && systemctl reload nginx`。
10. 执行验收清单。

#### 1.12 验收清单

基础：

```bash
curl -f http://127.0.0.1:3001/api/health
curl -I http://financial.example.com/
curl -f http://financial.example.com/api/health
pm2 status
pm2 logs financial-api --lines 100
```

业务：

- 首页可访问。
- 平台入口可打开。
- A 股工作台可加载。
- Futu 状态显示 OpenD 可用、Python SDK 可用、账户登录状态正确。
- Longbridge 状态显示凭证可用。
- SQLite 历史接口可分页读取。
- 真实交易按钮默认不可自动提交，除非明确打开门禁。

真实交易前最终确认：

- `LIVE_TRADING_ENABLED=true` 只在真实交易窗口开启。
- `FUTU_LIVE_TRD_ENV=REAL` 已确认账户和环境。
- `FUTU_AUTO_SUBMIT_ENABLED=false` 作为首轮生产默认值。
- `LONGBRIDGE_LIVE_TRADING_ENABLED=true` 仅在长桥真实交易验收后开启。
- 单笔金额、仓位比例、A 股 100 股整数手等风控参数已经复核。

#### 1.13 日志、备份与回滚

日志：

- PM2：使用 `pm2-logrotate`，限制单文件大小和保留天数。
- Nginx：接入系统 `logrotate`。
- 应用：生产默认 `LOG_LEVEL=info`、`LOG_PRETTY=false`。

备份：

- 每日备份 `/opt/financial/shared/.data/*.sqlite3`。
- 每次发布前备份 `.data` 中关键 DB。
- `.env` 不进入代码仓库，只进入服务器安全备份。

回滚：

```bash
ln -sfn /opt/financial/releases/<previous> /opt/financial/current
pm2 reload financial-api --update-env
nginx -t && systemctl reload nginx
curl -f http://127.0.0.1:3001/api/health
```

#### 1.14 已知限制与后续优化

当前限制：

- 后端生产以 `tsx api/server.ts` 运行，依赖 TypeScript 源码和 devDependency 中的 `tsx`。
- `api/app.ts` 目前不服务 `dist/`，因此生产必须由 Nginx 服务前端静态资源。
- Futu bridge 中默认 Python user site 包含 macOS 路径兜底，Linux 生产必须显式设置 `FUTU_PYTHON_BIN` / `PYTHONPATH`，避免依赖兜底路径。
- `.data` SQLite 是单机本地持久化，不适合多实例 API 水平扩容。

后续优化：

- 新增后端生产编译配置，例如 `tsconfig.server.json` 输出到 `api-dist/`。
- 新增 `npm run server:build` 和 `npm run server:start`。
- 新增 `ecosystem.config.cjs` 到仓库。
- 新增 `docs/linux-pm2-nginx-deployment.md` 正式文档。
- 新增健康检查脚本和发布脚本。
- 将 `.env.example` 补齐为生产模板，避免直接参考 `.env.local`。

## Assumptions & Decisions

- 采用裸机部署，不使用 Docker Compose。
- Nginx 负责前端静态资源和 API 反代。
- API 服务单实例运行，避免 SQLite 多进程写入风险。
- 真实交易能力纳入文档，但默认门禁关闭；开启真实下单需要人工复核环境变量和风控参数。
- 生产持久化目录放在 `/opt/financial/shared/.data`，发布包不覆盖。
- 服务器构建优先于 macOS 本地打 Linux 包，避免 `node_modules` 平台差异。
- 当前阶段不改代码，仅输出部署 runbook；若后续要落地，可新增正式 `docs/` 文档、PM2 配置和环境变量模板。

## Verification Steps

文档落地后建议按以下方式验证：

1. 在本地确认文档中的项目事实仍然成立：

```bash
npm run check
npm run lint
npm run test
npm run build
```

2. 在测试 Linux 服务器完成一次 dry-run 部署。
3. 验证基础服务：

```bash
curl -f http://127.0.0.1:3001/api/health
curl -f http://<domain>/api/health
```

4. 验证市场数据能力：

```bash
curl -s http://127.0.0.1:3001/api/source/status
curl -s http://127.0.0.1:3001/api/a-share/dashboard
```

5. 验证 PM2 与 Nginx：

```bash
pm2 status
pm2 describe financial-api
nginx -t
systemctl status nginx
```

6. 验证持久化：

- 重启 API 后历史数据仍存在。
- 发布新 release 后 `.data/*.sqlite3` 没有被覆盖。

7. 验证真实交易门禁：

- 默认 `LIVE_TRADING_ENABLED=false` 和 `LONGBRIDGE_LIVE_TRADING_ENABLED=false` 时，确认接口不会提交真实订单。
- 人工复核后再短时开启真实交易门禁，并优先使用最小金额测试。

