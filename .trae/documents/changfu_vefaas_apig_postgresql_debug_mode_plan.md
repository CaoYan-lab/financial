# 长富 veFaaS、API Gateway、PostgreSQL 与 macOS Debug 模式实施方案

> 状态：代码与首轮云端部署完成；客户端正式签名发布待后续执行
>
> 日期：2026-09-28
>
> 依据：`.trae/documents/changfu_desktop_architecture_plan.md`

## 一、Summary

本次工作分为两个相互配套的交付：

1. 将 `changfu-backend` 以独立的 Gateway 与 Decision Worker 部署到火山引擎 veFaaS，经 API Gateway 提供唯一公网 HTTPS 入口，并接入现有北京区 AIDAP PostgreSQL。
2. 为 macOS 客户端增加隐藏 Debug 模式：连续 5 次点击顶部“只读设备”文字后，当前进程切换到本机 Gateway；左上角持续展示“Debug 模式开启中”和关闭按钮；关闭后切回云端。

已锁定的产品决策：

- 复用现有 `cn-beijing` 的 `fin-vpc`、AIDAP `financial`、CR 和 APIG 实例。
- 新增长富专用数据库账号、`changfu` schema、镜像、函数、APIG 服务/路由、TLS 日志主题和告警，不复用 `fin-web`、`fin-worker` 运行时。
- 公网入口固定使用 APIG 默认 HTTPS 域名，不绑定自定义域名和证书。
- 客户端只连接 Gateway。Debug 模式固定连接 `http://127.0.0.1:4310`，由本地 Gateway 连接 `http://127.0.0.1:4311` Worker；客户端不直接暴露或调用 Worker 内部接口。
- Debug 状态不持久化。应用每次启动均回到云端；切换环境时终止运行任务、退出当前环境并要求在目标环境重新登录。

## 二、Current State Analysis

### 2.1 已具备能力

- `changfu-backend/apps/gateway/src/server.ts`
  - Node HTTP Gateway，监听 `CHANGFU_GATEWAY_HOST/PORT`。
  - 已实现登录、令牌刷新、订阅、Provider 池、交易控制面、SELL PUT、模型请求和幂等。
  - 通过 `CHANGFU_DECISION_WORKER_URL` 调用 Worker。
- `changfu-backend/apps/decision-worker/src/server.ts`
  - Node HTTP Worker，内部接口为 `/internal/v1/*`。
  - 使用 `CHANGFU_INTERNAL_TOKEN` 做固定时长比较鉴权。
  - 模型请求上限为 300 秒。
- `changfu-backend/migrations/001...009`
  - 已建立完整 `changfu` schema。
  - 外键及认证查询依赖同库的 `public.cloud_users` 和 `multiuser.user_profiles`。
- `changfu-backend/deploy/Dockerfile`
  - 已有 Node 24 多阶段构建基础，但运行镜像未复制 `catalog/`，当前直接用于云部署会在启动阶段找不到交易/套餐目录。
- `deploy/volcano`
  - 已有现网 `fin-web/fin-worker` 的 veFaaS、CR、VPC、AIDAP 和发布机实践，可复用流程，不复用业务资源。
- `changfu-desktop/macos/App/RootView.swift`
  - 顶栏已有“只读设备”文字，是隐藏入口的准确落点。
- `changfu-desktop/macos/App/AppState.swift`
  - 当前 `BackendClient` 在初始化时固定为 `CHANGFU_API_BASE_URL`，默认值为本机 `4310`，不支持运行中切换。
- `changfu-desktop/macos/Infrastructure/SecureCredentialStore.swift`
  - refresh token 只有一个固定 Keychain account，直接切换环境会产生云端/本地令牌串用风险。

### 2.2 必须修正的部署差距

- 正式客户端不能继续默认连接 `127.0.0.1:4310`。
- Gateway 与 Worker 镜像、启动命令和函数配置尚未形成长富独立发布链路。
- 当前没有生产迁移账本；`run-local.sh` 只是依次重放 SQL 文件，不适合作为生产发布门禁。
- 当前健康检查只检查配置字段是否存在，不验证 PostgreSQL 与 Worker 是否可达。
- Gateway 会等待 Worker 完成并缓冲完整 NDJSON，再返回客户端；当前不是逐事件流式转发。首版云部署保留该行为，因此所有链路超时必须覆盖 300 秒模型上限。
- 云端 RDS 必须继续包含 `public.cloud_users` 与 `multiuser.user_profiles`，不能只部署一个空的 `changfu` schema。
- 本机未安装 `ve` CLI，计划阶段无法读取实时云资源。实施时必须先在指定部署机完成只读盘点，再生成资源变更命令。

## 三、目标架构

```text
macOS App
  ├─ Cloud: https://${CHANGFU_PUBLIC_API_ORIGIN}
  └─ Debug: http://127.0.0.1:4310
              |
              v
API Gateway 公网 HTTPS 服务
              |
              v
changfu-gateway veFaaS Web 应用函数
  ├─ VPC 内网 -> AIDAP PostgreSQL / financial
  └─ VPC 私网 HTTPS -> changfu-decision-worker
                              |
                              ├─ VPC 内网 -> AIDAP PostgreSQL / financial
                              └─ HTTPS/PrivateLink -> Ark 或受控第三方模型
```

资源隔离：

| 类型 | 名称 |
|---|---|
| CR 仓库 | `fin/changfu-backend` |
| Gateway 函数 | `changfu-gateway` |
| Worker 函数 | `changfu-decision-worker` |
| APIG 服务 | `changfu-desktop-api` |
| 公网 Upstream | `changfu-gateway-vefaas` |
| Worker 私网服务/Upstream | `changfu-worker-internal` |
| TLS 主题 | `changfu-gateway`、`changfu-decision-worker` |
| RDS 运行账号 | `changfu_runtime` |
| 数据库 | 复用 `financial` |
| schema | `changfu` |

公网只允许访问 Gateway。Worker 仅通过 APIG 私网域名进入，并继续校验 `CHANGFU_INTERNAL_TOKEN`。首版保持当前 HTTP/NDJSON 协议，不在本次部署中引入 gRPC 重写。

## 四、Proposed Changes

### 4.1 固化架构文档

文件：`.trae/documents/changfu_desktop_architecture_plan.md`

在文末追加“veFaaS/APIG/RDS 部署与 Debug 环境切换”章节：

- 记录本方案的资源命名、网络、超时、数据库账号和发布顺序。
- 将当前实际 Gateway → Worker 协议明确为“私网 HTTPS + 内部 Bearer Token + NDJSON”；mTLS gRPC 保留为后续强化项，不把未实现能力写成现状。
- 明确客户端生产默认云端、Debug 仅当前进程有效、环境切换强制重新认证。

### 4.2 后端运行时适配

文件：`changfu-backend/apps/gateway/src/server.ts`

- 将 PostgreSQL Pool 参数改为环境可配置：
  - `CHANGFU_PG_POOL_MAX`
  - `CHANGFU_PG_CONNECTION_TIMEOUT_MS`
  - `CHANGFU_PG_IDLE_TIMEOUT_MS`
- 增加 `/v1/ready`：
  - 执行轻量 `SELECT 1`。
  - 请求 Worker `/internal/v1/health`。
  - 只返回 `ok/database/worker` 布尔状态，不返回地址、错误正文或 Secret。
- 为 Gateway → Worker fetch 设置显式 330 秒超时，并在客户端断开时继续向 Worker 传播取消。
- 添加 `SIGTERM/SIGINT` 优雅关闭：停止接收请求、等待短暂 drain、关闭 PG Pool。
- 保持 2 MiB `ContextEnvelope` 上限；部署侧不得启用请求体日志采集。

文件：`changfu-backend/apps/decision-worker/src/server.ts`

- 复用相同的 PostgreSQL Pool 配置项。
- `/internal/v1/health` 增加数据库可用性检查，但不执行真实模型调用。
- 保持模型调用 300 秒上限；函数请求超时设置为 330 秒以上。
- 添加 `SIGTERM/SIGINT` 优雅关闭与 PG Pool 回收。

文件：`changfu-backend/packages/observability/src/safeLogger.ts`

- 增加对 API Key、私钥、数据库 URL、内部 Token、模型原始响应等键名的拒绝列表。
- 测试日志只能记录 requestId、阶段、耗时、状态码和受控错误码。

### 4.3 数据库迁移与权限

新增：`changfu-backend/migrations/000_migration_metadata.sql`

- 创建 `changfu.schema_migrations(version, checksum, applied_at)`。
- 迁移执行使用 PostgreSQL advisory lock，保证并发发布只能有一个迁移器。

新增：`changfu-backend/scripts/migrate.ts`

- 按文件名顺序执行 `000...009`。
- 已执行版本校验 SHA-256；同版本内容发生变化时失败关闭。
- 单个迁移在事务中执行，失败回滚并阻断函数发布。
- 不在 Gateway/Worker 启动时自动跑 DDL。

新增：`changfu-backend/scripts/verify-database.ts`

- 校验 `public.cloud_users`、`multiuser.user_profiles`、全部 `changfu` 表、索引、约束和迁移 checksum。
- 校验运行账号可执行所需 DML，但不能修改 `public`/`multiuser` 表结构。

数据库权限：

- 复用现有 `financial` 数据库。
- 现有管理账号仅用于迁移。
- AIDAP 账号 `changfu_app` 被平台强制授予 `neon_superuser`，不得用于运行时。
- 在数据库内新建无管理权限的登录角色 `changfu_runtime` 作为运行账号：
  - `USAGE`：`public`、`multiuser`、`changfu`。
  - `SELECT`：`multiuser.user_profiles`。
  - `SELECT` 与仅 `last_login_at` 更新：`public.cloud_users`。
  - `SELECT/INSERT/UPDATE/DELETE`：`changfu` 表。
  - sequence 使用权限。
  - 不授予 `public`/`multiuser` DDL 权限。
- RDS 只使用私网连接池端点，白名单只允许 veFaaS 所在 VPC/子网，不开公网，不配置 `0.0.0.0/0`。
- 连接串启用 SSL；密码和连接串只从部署机受限 Secret/环境注入。

### 4.4 veFaaS 镜像与函数

新增目录：`changfu-backend/deploy/volcano/`

新增：`deploy/volcano/Dockerfile.vefaas`

- Node 24 多阶段构建。
- 构建阶段执行 `npm ci`、typecheck、测试、build。
- 运行阶段复制 `dist/`、`catalog/`、生产依赖和必要 CA 证书。
- 使用非 root 用户，监听 `0.0.0.0:8000`。
- 提供 `gateway`、`worker` 两个独立 target，产出两个独立镜像标签。

新增：

- `deploy/volcano/run-gateway.sh`
- `deploy/volcano/run-worker.sh`
- `deploy/volcano/env/.env.cloud.example`
- `deploy/volcano/scripts/build-and-push-image.sh`
- `deploy/volcano/scripts/release-from-deploy-host.sh`
- `deploy/volcano/scripts/inventory.sh`
- `deploy/volcano/scripts/migrate-rds.sh`
- `deploy/volcano/scripts/verify-deployment.sh`

发布脚本规则：

- 强制只允许指定部署机 `ECS-0EJj-deploy` 执行。
- 使用不可变版本标签 `vNN-<git-sha>`，禁止生产使用 `latest`。
- 先构建并测试，再推送 CR。
- 固定顺序：数据库迁移 → Worker 发布并通过私网健康检查 → Gateway 发布 → APIG 冒烟。
- 任何阶段失败停止后续步骤，不修改 `fin-web/fin-worker`。
- 保留上一 Revision；回滚只切换长富函数 Revision。

veFaaS 建议配置：

| 配置 | Gateway | Worker |
|---|---:|---:|
| 类型 | Web 应用函数 | Web 应用函数 |
| Runtime | `native/v1` | `native/v1` |
| 端口 | 8000 | 8000 |
| CPU/内存初值 | 1 vCPU / 2 GiB | 2 vCPU / 4 GiB |
| Min 实例 | 1 | 1 |
| Max 实例 | 4 | 4 |
| 单实例并发 | 20 | 10 |
| 请求超时 | veFaaS 360 秒；APIG 路由关闭额外超时 | veFaaS 330 秒；APIG 路由关闭额外超时 |
| VPC | 现有 `fin-vpc` 双可用区子网 | 同左 |
| 公网访问 | 关闭直接入口；由 APIG 暴露 | 关闭 |
| TLS 日志 | 独立主题 | 独立主题 |

并发预算按最坏情况控制 PostgreSQL 连接数。默认 Gateway Pool=5、Worker Pool=3；上线前以 RDS 最大连接数校验 `函数最大实例数 × Pool Max`，至少保留 30% 余量。

### 4.5 API Gateway

新增：`changfu-backend/deploy/volcano/scripts/configure-apig.sh`

公网服务：

- 在现有 APIG 实例中新建 `changfu-desktop-api` 服务。
- 新建 veFaaS Upstream 指向已发布的 `changfu-gateway`。
- 路由前缀 `/v1`，允许代码实际使用的 GET/POST/PUT/DELETE/OPTIONS。
- 使用 APIG 默认 HTTPS 域名，不绑定自定义域名和证书。
- 不启用 CORS；原生客户端无需浏览器跨域。
- 禁止网关记录请求体与 Authorization。
- `POST /v1/auth/login` 配置更严格的 IP 速率限制；模型和报告接口配置单独限流。
- 网关等待超时设置为 360 秒或关闭该额外限制，以 Worker 300 秒超时为业务上限。

Worker 私网服务：

- 新建 APIG 服务与 veFaaS Upstream 指向 `changfu-decision-worker`，Gateway 只使用其私网 Origin。
- 当前 APIG 默认域名同时提供公网和私网地址；内部 POST 路由必须继续校验高熵 Token，未授权公网请求返回 401。
- 仅配置 `/internal/v1/health`、`/internal/v1/model/runs`、`/internal/v1/sell-put/report`。
- Gateway 的 `CHANGFU_DECISION_WORKER_URL` 指向该私网 HTTPS Origin。
- Worker 仍校验高熵 `CHANGFU_INTERNAL_TOKEN`；该 Token 独立于客户端 JWT，并支持发布时轮换。

如果实时盘点发现当前 APIG Serverless 实例不支持所需私网服务，则在同 VPC 创建标准 APIG 实例承载长富公网和私网服务；不把 Worker 暴露到公网作为降级方案。

### 4.6 Secret 与环境变量

Gateway：

- `CHANGFU_GATEWAY_PORT=8000`
- `CHANGFU_DATABASE_URL`
- `CHANGFU_DECISION_WORKER_URL`
- `CHANGFU_ACCESS_PUBLIC_KEY_PEM`
- `CHANGFU_ACCESS_PRIVATE_KEY_PEM`
- `CHANGFU_ACCESS_KEY_ID`
- `CHANGFU_INTERNAL_TOKEN`
- `CHANGFU_MODEL_CREDENTIAL_KEY`
- PostgreSQL Pool 配置

Worker：

- `CHANGFU_DECISION_WORKER_PORT=8000`
- `CHANGFU_DATABASE_URL`
- `CHANGFU_INTERNAL_TOKEN`
- `CHANGFU_ARK_API_KEY`
- `CHANGFU_ARK_MODEL`
- `CHANGFU_ARK_ENDPOINT`
- `CHANGFU_MODEL_CREDENTIAL_KEY`
- `CHANGFU_MODEL_REQUEST_TIMEOUT_MS=300000`
- PostgreSQL Pool 配置

私钥、API Key、数据库密码、内部 Token 不写 Git、镜像层、普通日志或命令输出。`CHANGFU_ACCESS_PRIVATE_KEY_PEM` 与 `CHANGFU_MODEL_CREDENTIAL_KEY` 必须在首次生产部署前生成并离线备份；丢失后分别会导致现有登录令牌失效和第三方模型凭据不可解密。

### 4.7 macOS 环境切换模型

新增：`changfu-desktop/macos/Infrastructure/BackendEnvironment.swift`

- 定义 `cloud` 与 `debugLocal`：
  - `cloud`: `https://${CHANGFU_PUBLIC_API_ORIGIN}`
  - `debugLocal`: `http://127.0.0.1:4310`
- 云端 URL 从单一配置常量读取；正式构建门禁拒绝 `.invalid`、localhost 和非 HTTPS。
- 环境显示文案与内部 URL 分离，界面不展示完整服务地址。

修改：`changfu-desktop/macos/Infrastructure/BackendClient.swift`

- 保持单个 Client 的 `baseURL` 不可变。
- 在 AppState 切换环境时创建新 Client，避免请求中途修改 URL。
- 将请求超时统一到云端链路预算：模型/报告客户端上限 330 秒，普通接口维持短超时。

修改：`changfu-desktop/macos/Infrastructure/SecureCredentialStore.swift`

- refresh token 按环境分 Keychain account：
  - `refresh-token.cloud`
  - `refresh-token.debug-local`
- 设备签名密钥与设备 ID继续共用；Longbridge 本地凭据不随后端环境切换。
- 不迁移旧 `refresh-token` 到 Debug；实施时仅允许一次性迁移到 cloud 命名空间，随后删除旧键。

修改：`changfu-desktop/macos/App/AppState.swift`

- 新增只读状态 `backendEnvironment`、`isDebugMode`、可替换的 `backend`。
- 每次初始化固定为 `.cloud`，不从 UserDefaults 恢复 Debug。
- 新增 `enableDebugMode()` 与 `disableDebugMode()`，统一调用 `switchBackendEnvironment(to:)`。
- 切换顺序固定：
  1. 禁止重复切换。
  2. 取消认证刷新、Broker 定时刷新、SELL PUT、影子评估和启动广告任务。
  3. 对当前环境执行 best-effort logout。
  4. 清理当前内存会话、服务端派生数据与当前环境 refresh token。
  5. 替换 BackendClient。
  6. Debug 模式调用 `GET /v1/ready`，同时确认本地 Gateway、Worker 和 PostgreSQL。
  7. 进入目标环境登录页，不自动复用另一环境令牌。
- 切换不清除设备签名身份、券商本地凭据和普通 UI 偏好。

修改：`changfu-desktop/macos/App/RootView.swift`

- 仅对“只读设备”四个字挂载 `TapGesture(count: 5)`；状态圆点不计入点击。
- 未开启 Debug 时不显示任何开发入口或提示。
- Debug 开启后，在左上角品牌区域展示高对比但不遮挡的“Debug 模式开启中”。
- 紧邻提示提供 `xmark.circle.fill` 图标按钮，tooltip 为“关闭调试模式”；点击后切回 cloud 并回到登录页。
- 切换过程中禁用入口，避免并发状态清理。

修改：`changfu-desktop/macos/App/AuthenticationGateView.swift`

- 登录页在 Debug 环境显示同一左上角 Debug 标识和关闭按钮，保证切换到本地后即使尚未登录也能返回云端。
- 本地依赖不可用时显示“本地 Gateway、Worker 或 PostgreSQL 未就绪”，不回退云端，不静默复用云端令牌。

### 4.8 测试

文件：`changfu-backend/tests/*`

新增或扩展：

- readiness：数据库/Worker 全部正常、任一失败、超时、响应脱敏。
- Gateway → Worker 330 秒取消与客户端断开传播。
- Pool 环境变量边界和非法值回退。
- 迁移 runner：首次执行、重复执行、checksum 冲突、并发 advisory lock、失败回滚。
- Secret/原始上下文不会进入日志。

文件：`changfu-desktop/macos/TestRunner/main.swift`

新增：

- App 启动始终为 cloud。
- 第 1 至 4 次点击不切换，第 5 次连续点击切到 Debug。
- Debug Base URL 为 `127.0.0.1:4310`，无 Worker 直连请求。
- 切换时取消任务、清空会话、使用环境独立 Keychain account。
- Debug readiness 任一依赖失败时保持 Debug 登录页并显示明确错误。
- 关闭按钮切回 cloud，且不会复用 Debug token。
- 生产 URL 非 HTTPS/localhost/占位值时发布门禁失败。

## 五、云资源实施顺序

1. 在指定部署机安装并校验 `ve >= 1.1.11`，只读确认账号、地域、VPC、子网、CR、APIG、RDS、TLS 现状。
2. 输出将创建/修改的完整资源命令与影响；云资源写操作按 Volcengine CLI 规则先 DryRun，获得确认后执行。
3. 创建 CR 仓库、TLS 主题和长富运行账号；配置 RDS 私网白名单。
4. 备份 `financial`，运行 `migrate.ts`，执行数据库权限与 schema 校验。
5. 构建两个不可变镜像并完成本地容器健康检查，推送 CR。
6. 创建并发布 Worker，接入 VPC/RDS/Ark，先验证私网健康。
7. 创建并发布 Gateway，接入 VPC/RDS/Worker。
8. 创建 Worker 私网 APIG 服务，再创建公网 Gateway 服务。
9. 将 APIG 默认 HTTPS Origin 写入 App 的 Info.plist 和代码兜底配置。
10. 配置 TLS、APIG、veFaaS、RDS 告警。
11. 灰度一台测试设备，完成认证、Provider 隔离、SELL PUT、模型、幂等和重启恢复验收。
12. 扩大设备白名单；保留上一函数 Revision 和数据库备份。

## 六、Verification

### 6.1 后端静态与单元

- `npm run typecheck`
- `npm test`
- `npm run build`
- 新核心模块覆盖率不低于 85%。
- 镜像内以非 root 用户启动，`catalog/` 可解析，两个入口均监听 `0.0.0.0:8000`。

### 6.2 数据库

- 迁移 000–009 只执行一次且 checksum 一致。
- 现有 `public`、`multiuser` 行数不变化。
- `changfu_runtime` 无权执行 `DROP/ALTER` 到共享 schema。
- 登录、refresh、订阅、Provider 池、模型运行、SELL PUT 报告均可正常读写。
- 抽查 `model_runs`、日志、错误堆栈不含原始账户/持仓/行情上下文。

### 6.3 云端链路

- Worker 私网健康 200，公网无法访问 Worker。
- Gateway `/v1/health` 与 `/v1/ready` 200。
- APIG 默认 HTTPS 域名可访问，且 App 默认配置与该 Origin 完全一致。
- 2 MiB 请求成功；超限请求在 Gateway 以 413 失败。
- 300 秒以内模型请求不被 veFaaS/APIG 提前 504。
- Gateway/Worker 滚动发布期间幂等键不产生重复模型记录。
- RDS、Worker、Ark 任一故障均失败关闭，不回退本地或其他 Provider。

### 6.4 macOS Debug

- 云端启动无 Debug 文案。
- 连续 5 次点击“只读设备”后才切换。
- 左上角 Debug 标识和关闭按钮在登录页、工作台均可见且不遮挡其他控件。
- Debug 请求只到 `127.0.0.1:4310`；Gateway 再访问 `127.0.0.1:4311`。
- 切换前正在运行的研究、模型和刷新任务被取消。
- 云端与本地 refresh token 不串用。
- 重启 App 自动回云端。
- 关闭 Debug 后回云端登录页，并能重新完成云端认证。

### 6.5 回滚

- 客户端：回退到上一签名版本；服务端环境切换不改变券商本地凭据。
- Gateway/Worker：分别回切上一 veFaaS Revision，顺序为 Worker 后 Gateway。
- APIG：保留旧 Upstream，权重切回上一 Revision。
- PostgreSQL：新增迁移只前向修复；上线前备份用于灾难恢复，不自动执行破坏性 down migration。

## 七、Assumptions & Decisions

- 地域固定 `cn-beijing`。
- 复用现有 `financial` 数据库是为了保持 `cloud_users` 与 `user_profiles` 的唯一事实来源。
- Debug 模式不是绕过认证；本地后台也必须登录。
- 客户端不直接连接 Worker，避免暴露内部协议与 Token。
- 首版保留当前 Gateway 缓冲 NDJSON 的行为；真正逐事件流式转发另立任务，不混入本次部署。
- 首版不修改 Windows 客户端。
- 不修改现有 `fin-web`、`fin-worker`、现有云端 OpenD 或其发布脚本。
- 不绑定自定义域名和证书，正式客户端直接使用 APIG 默认 HTTPS Origin。

## 八、2026-09-28 首轮部署结果

- 镜像：`v1-247bf2376000-gateway`、`v1-247bf2376000-worker`、
  `v1-247bf2376000-migrator`。
- veFaaS：Gateway `1j89q2s3`，Worker `llh7dd7h`；二者 Revision 1 已发布，
  `MinInstance=1`、`MaxInstance=4`。
- APIG 公网服务：`s1t8is7jgm85sfs523g5l`，公网 Origin 为
  `https://s1t8is7jgm85sfs523g5l.apigateway-cn-beijing.volceapi.com`。
- APIG Worker 服务：`sp33su7erhd197sn87lsu`，Gateway 使用私网 Origin
  `https://sp33su7erhd197sn87lsu.apigateway-cn-beijing-inner.volceapi.com`。
- 数据库迁移 000-009、checksum、运行权限校验通过。
- 公网 `/v1/health` 与 `/v1/ready` 返回 200；`ready` 中数据库和 Worker
  均为可用。Worker 公网模型路由无 Token 返回 401。

## 九、官方约束依据

- veFaaS Web 应用支持自定义镜像，镜像需与函数同地域，HTTP Server 必须监听 `0.0.0.0:<Port>`：
  <https://www.volcengine.com/docs/6662/1322678>
- veFaaS 同步调用、请求体、并发和 VPC 限制：
  <https://www.volcengine.com/docs/6662/97171>
- API Gateway 可将已发布 veFaaS 函数配置为 Upstream，且必须同地域：
  <https://www.volcengine.com/docs/6569/111770>
- API Gateway 路由超时可关闭；开启后超时返回 504：
  <https://www.volcengine.com/docs/6569/135722>
- 长富 APIG 路由统一关闭额外超时，由 veFaaS 与应用层超时负责截止。生产实测表明在当前
  APIG/veFaaS 组合下显式 `Timeout` 会提前取消仍在执行的函数请求，表现为
  `504 upstream request timeout` 和函数日志 `client canceled request`。
- RDS PostgreSQL 实例需与调用方同地域/VPC，并配置子网：
  <https://docs.volcengine.com/docs/6438/79254>
- RDS PostgreSQL 私网连接同样必须配置白名单，禁止使用 `0.0.0.0/0`：
  <https://www.volcengine.com/docs/6438/81227>
