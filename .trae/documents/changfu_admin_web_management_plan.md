# 长富 Web 管理端实施计划

## 一、Summary

为已经上线的长富 macOS 客户端、Gateway、Decision Worker 和 PostgreSQL 增加一套独立的内部 Web 管理端，覆盖：

1. 用户创建、查询、修改、停用、密码重置。
2. 固定三档套餐（轻量版、高级版、旗舰版）的完整明细、价格和版本生命周期管理。
3. 用户与套餐关系的人工授予、调整、冻结、取消，以及券商槽位占用查看和绑定调整。
4. 全局官方“长富Pro”模型 Endpoint、协议、模型 ID、API Key、启停、测试、版本和回滚管理。
5. 默认管理员 `admin` 首次启动时写入 PostgreSQL。

管理端采用独立 Admin Web + Admin API 服务，不并入桌面 Gateway，也不复用旧交易 Web。浏览器只通过 HTTPS Admin API 访问数据，绝不直接连接 PostgreSQL。Admin API 使用独立数据库运行账号和独立管理员身份表，以最小权限访问同一 `financial` 数据库。

初始管理员密码使用用户已指定的值，但该值只通过部署 Secret `CHANGFU_ADMIN_INITIAL_PASSWORD` 注入，不写入代码、迁移、计划、日志或镜像；数据库只保存 scrypt 哈希。首次登录强制修改密码。

## 二、Current State Analysis

### 2.1 已有系统边界

- `changfu-backend/apps/gateway/src/server.ts` 是桌面客户端公网 API，使用 EdDSA Bearer Token，并把用户身份绑定到设备，不适合作为浏览器管理后台鉴权。
- `changfu-backend/apps/decision-worker/src/server.ts` 当前通过 `CHANGFU_ARK_ENDPOINT`、`CHANGFU_ARK_MODEL`、`CHANGFU_ARK_API_KEY` 获取官方模型配置。
- `changfu-backend/deploy/volcano/Dockerfile.vefaas` 目前只有 gateway、worker、migrator 三个镜像目标。
- `changfu-backend/deploy/volcano/scripts/configure-apig.sh` 目前只创建桌面公网服务和 Worker 内部服务。
- 现网使用 `financial` PostgreSQL、`fin-vpc`、`fin-sg-faas`、`fin-apig` 和私有 CR；Admin 服务应复用这些基础设施，但必须创建独立函数、镜像、APIG service/upstream/route。

### 2.2 用户与权限

- 业务用户账号位于 `public.cloud_users`，档案位于 `multiuser.user_profiles`。
- 桌面登录要求用户同时存在于两表且 `user_profiles.active = true`。
- 现有根目录 Web 服务包含 owner/member 管理逻辑，但它属于旧 Web 交易系统，不应继续承载新长富管理端。
- 长富 Gateway 的 `changfu_runtime` 数据库角色只有 `cloud_users`/`user_profiles` 的读取和 `last_login_at` 更新权限，不能安全地复用为管理员写账号角色。
- 当前没有独立的管理端用户、管理会话、CSRF、管理操作审计表。

### 2.3 套餐与订阅

- `changfu-backend/migrations/003_subscriptions_provider_pools.sql` 已具备套餐版本、价格、用户订阅、券商槽位、订单和订阅事件结构。
- `subscription_plan_versions.status` 已支持 `DRAFT/ACTIVE/RETIRED`，但 TypeScript 目录类型仅接受 `ACTIVE`。
- 套餐当前从 `changfu-backend/catalog/subscriptions/catalog.v1.json` 启动加载并写库，Gateway 和 `PostgresSubscriptionRepository` 持有启动时内存快照，因此管理端改库后不能热生效。
- 历史订阅和订单引用具体 `plan_version_id`。套餐不应原地覆盖或物理删除，否则会破坏账务及权益审计。

### 2.4 用户套餐关系

- `changfu.user_subscriptions` 每个用户最多有一个 `ACTIVE/FROZEN` 当前订阅。
- `changfu.subscription_broker_slots` 已保存槽位序号、Provider、状态、绑定时间和下次可换绑时间。
- 当前订阅生效主要由支付成功订单驱动，没有“管理员人工授予”来源与审计模型。
- 管理端不能伪造 `PAID` 订单；需要独立的人工授予记录，并在同一事务内更新订阅、槽位和订阅事件。

### 2.5 长富Pro

- 当前官方长富Pro配置来自 Worker 环境变量，修改需要重新发布。
- `changfu.third_party_model_configs` 是旗舰用户自行维护的用户级第三方模型配置，不能被改造成全局官方配置。
- 已有 AES-256-GCM 凭据加密和 Endpoint SSRF 防护能力，可复用于全局模型配置。
- 普通模型运行与 SELL PUT 报告目前存在两段官方模型调用逻辑，切换为数据库配置时必须同时覆盖，避免业务路径使用不同模型。

## 三、Assumptions & Decisions

### 3.1 产品范围

- 管理端仅供内部管理员使用，首版只有一个 `SUPER_ADMIN` 权限等级；数据结构保留未来增加管理员的能力。
- 首版用户资料沿用现有最小字段：用户名、显示名、临时密码、启用状态、首次改密状态、创建时间、最近登录时间。
- 用户“删除”统一解释为停用：撤销 Web/桌面会话并禁止新登录，不物理删除交易、报告、订阅或审计数据。
- 套餐类型固定为 `LITE/PRO/FLAGSHIP`。创建表示为某个固定套餐代码创建新版本；修改只允许编辑草稿；发布后不可原地修改。
- 套餐“删除”统一解释为退役。退役版本不可新购或新授予，但历史订阅继续按其版本权益运行到被调整或到期。
- 管理端人工授予可用于首次开通和后续调整，不创建支付订单；原因字段必填。
- 长富Pro是全局官方模型，与旗舰用户的 `third_party_model_configs` 完全分离。

### 3.2 管理端部署

- 新建一个 `changfu-admin` veFaaS Web Function，同时托管静态 React 管理页面和 `/api/v1/admin/*` API。
- 新建独立 APIG service、upstream 和公网 HTTPS route；不修改现有桌面公网路由和 Worker 私网路由。
- Admin Function 接入现有 VPC、子网、安全组和 PostgreSQL。
- 管理端默认同源部署，不开启宽泛 CORS。

### 3.3 管理员播种与会话

- 默认用户名固定为 `admin`。
- Admin 服务启动时仅在 `changfu_admin.admin_users` 为空时读取 `CHANGFU_ADMIN_INITIAL_PASSWORD`，生成随机盐的 scrypt 哈希后插入数据库。
- 播种操作幂等；数据库已有管理员后，环境变量变化不得覆盖现有密码。
- 初始账号 `must_change_password = true`，完成改密前只能访问会话信息、改密和退出接口。
- 使用高熵随机不透明 Session Token；数据库仅保存 SHA-256 token hash。
- Cookie 设置 `HttpOnly; Secure; SameSite=Strict; Path=/`，管理会话采用绝对过期和空闲过期双门禁。
- 所有写请求要求同会话绑定的 CSRF Token，并执行 Origin 校验和 `Idempotency-Key` 校验。
- 登录按 IP 和用户名限速；停用管理员或修改密码时撤销全部会话。

## 四、Proposed Changes

### 4.1 管理端数据库模型

新增 `changfu-backend/migrations/010_admin_console.sql`：

1. 创建 `changfu_admin` schema。
2. 创建 `changfu_admin.admin_users`：
   - UUID 主键、唯一用户名、密码哈希、角色、启用状态、强制改密状态。
   - 登录失败计数、锁定时间、最近登录时间、创建/更新时间。
3. 创建 `changfu_admin.admin_sessions`：
   - 仅保存 session token hash、CSRF token hash、管理员 ID、过期时间、最后活动时间、撤销时间。
   - 为有效期和管理员建立索引。
4. 创建 `changfu_admin.audit_events`：
   - 保存 actor、action、resource type/id、outcome、request ID、来源 IP、变更前后非敏感摘要和时间。
   - CHECK 禁止密码、token、API Key、Authorization 等敏感键。
5. 创建 `changfu_admin.subscription_grants`：
   - 保存用户、订阅、前后套餐版本、周期、起止时间、状态、保留 Provider、原因和管理员。
   - 作为人工授予/调整的不可变审计来源。
6. 为 `changfu.user_subscriptions` 增加 `source`（`PAYMENT`/`ADMIN_GRANT`）和可空的最近 grant 引用。
7. 扩展 `changfu.subscription_events.event_type`，加入人工授予、调整、冻结和取消事件。
8. 为 `changfu.subscription_plan_versions` 增加同一 `plan_code` 仅一个 `ACTIVE` 版本的部分唯一索引。
9. 创建 `changfu_admin.official_model_config_versions`：
   - UUID、版本号、显示名、协议、Endpoint、模型 ID。
   - AES-256-GCM 密文、nonce、auth tag、末四位和密钥版本。
   - `DRAFT/ACTIVE/RETIRED` 状态、测试结果/时间、创建人、激活人、时间戳。
   - 只允许一个 `ACTIVE` 官方配置。

新增 `changfu-backend/migrations/011_admin_mutation_idempotency.sql`：

- 独立保存管理员写请求的幂等键与请求 ID，不保存请求或响应正文。
- 010 已在本地验证库登记后保持内容不可变，后续表结构只能通过 011 增量迁移。

更新：

- `changfu-backend/tests/migrations.test.ts`：迁移数量和最新版本改为 011，并验证关键约束。
- `changfu-backend/tests/schemaPrivacy.test.ts`：覆盖管理员会话、审计和官方模型表的敏感字段约束。
- `changfu-backend/scripts/verify-database.ts`：验证 `changfu_admin` schema、表、索引和运行权限。

### 4.2 独立数据库角色与最小权限

修改：

- `changfu-backend/scripts/ensure-runtime-role.ts`
- `changfu-backend/scripts/apply-runtime-grants.ts`
- `changfu-backend/deploy/volcano/database/grants.sql`
- `changfu-backend/deploy/volcano/scripts/migrate-rds.sh`

实现：

- 保留现有 `changfu_runtime` 给 Gateway/Worker。
- 新建 `changfu_admin_runtime` 给 Admin Function。
- Admin 角色只获得：
  - `changfu_admin` 所需 DML。
  - `public.cloud_users` 的查询、插入及用户名/密码哈希/登录时间更新。
  - `multiuser.user_profiles` 的查询、插入及管理字段更新。
  - 套餐、价格、用户订阅、槽位、订阅事件和设备会话的必要 DML。
- 不授予 schema CREATE、migration ledger 写入、交易订单/模型结果正文等无关权限。
- Admin Function 使用独立 `CHANGFU_ADMIN_DATABASE_URL`，不能复用迁移账号。

### 4.3 管理员认证与审计模块

新增：

- `changfu-backend/packages/admin/src/password.ts`
- `changfu-backend/packages/admin/src/session.ts`
- `changfu-backend/packages/persistence/src/postgresAdminRepository.ts`
- `changfu-backend/apps/admin/src/http.ts`
- `changfu-backend/apps/admin/src/routes/auth.ts`
- `changfu-backend/apps/admin/src/server.ts`

接口：

- `POST /api/v1/admin/auth/login`
- `GET /api/v1/admin/auth/session`
- `POST /api/v1/admin/auth/password`
- `POST /api/v1/admin/auth/logout`
- `GET /api/v1/admin/health`
- `GET /api/v1/admin/ready`

规则：

- 登录错误统一返回相同文案，避免枚举管理员。
- 审计写入失败时，登录失败可以继续返回；任何管理写操作的审计写入必须与业务事务同成败。
- API 错误使用稳定错误码，不返回 SQL、堆栈、密码、Token 或密钥。
- 日志使用 `safeLogger`，只记录 request ID、资源 ID、动作、结果和耗时。

### 4.4 用户管理 API

新增：

- `changfu-backend/apps/admin/src/routes/users.ts`
- `changfu-backend/packages/persistence/src/postgresAdminUserRepository.ts`

接口：

- `GET /api/v1/admin/users?query=&status=&page=&pageSize=`
- `POST /api/v1/admin/users`
- `GET /api/v1/admin/users/{userId}`
- `PATCH /api/v1/admin/users/{userId}`
- `POST /api/v1/admin/users/{userId}/reset-password`
- `POST /api/v1/admin/users/{userId}/disable`
- `POST /api/v1/admin/users/{userId}/enable`

行为：

- 创建用户在一个事务内写入 `public.cloud_users` 和 `multiuser.user_profiles`，角色固定为 `member`，临时密码经过 scrypt，首次登录必须改密。
- 修改支持用户名、显示名；用户名唯一且修改后撤销现有 Web/桌面会话。
- 重置密码后设置 `must_change_password = true`，推进 `sessions_valid_after` 并撤销 `changfu.device_sessions`。
- 停用用户同时撤销全部设备会话；不修改 `liveTradingEnabled/autoSubmitEnabled` 的历史值，避免破坏状态连续性，但鉴权因用户停用而失效。
- 详情聚合账号信息、最近登录、设备数、券商连接、当前订阅、套餐版本、已用/总槽位和各槽位 Provider/状态。
- 列表使用服务端搜索、筛选和分页；不一次返回全部用户。

### 4.5 套餐目录改为数据库权威源

新增：

- `changfu-backend/packages/persistence/src/postgresSubscriptionCatalogRepository.ts`
- `changfu-backend/apps/admin/src/routes/plans.ts`

修改：

- `changfu-backend/packages/subscriptions/src/catalog.ts`
- `changfu-backend/packages/subscriptions/src/subscriptionService.ts`
- `changfu-backend/packages/persistence/src/postgresSubscriptionRepository.ts`
- `changfu-backend/apps/gateway/src/routes/subscriptions.ts`
- `changfu-backend/apps/gateway/src/server.ts`
- `changfu-backend/catalog/subscriptions/catalog.v1.json`

接口：

- `GET /api/v1/admin/plans`
- `GET /api/v1/admin/plans/{planCode}/versions`
- `POST /api/v1/admin/plans/{planCode}/versions`
- `PUT /api/v1/admin/plans/{planCode}/versions/{versionId}`
- `POST /api/v1/admin/plans/{planCode}/versions/{versionId}/publish`
- `POST /api/v1/admin/plans/{planCode}/versions/{versionId}/retire`

规则：

- `planCode` 仅允许 `LITE/PRO/FLAGSHIP`。
- 新版本默认从当前活动版本复制为 `DRAFT`，管理员可编辑：
  - 展示名称、生效时间。
  - 月/季/年价格（人民币分）。
  - 券商槽位数、每 Provider 池容量、月替换额度。
  - 批量上限、期权研究、期权交易等功能开关。
- 已发布版本不可编辑；变更必须创建更高版本。
- 发布事务校验完整三周期价格，退役旧活动版本并激活新版本。
- 退役不删除历史版本；已有用户继续引用原版本。
- `catalog.v1.json` 仅作为空库首次基线播种。Gateway 的目录读取、下单校验、升级/降级计算均改为按请求读取 PostgreSQL 当前活动版本，不再依赖进程启动时内存快照。
- Repository 按传入的 `planVersionId` 查询数据库，校验该版本是否允许当前动作，避免管理端发布后必须重启 Gateway。

### 4.6 用户套餐和槽位管理

新增：

- `changfu-backend/apps/admin/src/routes/userSubscriptions.ts`
- `changfu-backend/packages/persistence/src/postgresAdminSubscriptionRepository.ts`

接口：

- `GET /api/v1/admin/users/{userId}/subscription`
- `POST /api/v1/admin/users/{userId}/subscription-grants`
- `PATCH /api/v1/admin/users/{userId}/subscription`
- `POST /api/v1/admin/users/{userId}/subscription/freeze`
- `POST /api/v1/admin/users/{userId}/subscription/restore`
- `POST /api/v1/admin/users/{userId}/subscription/cancel`
- `PUT /api/v1/admin/users/{userId}/subscription/slots`
- `GET /api/v1/admin/users/{userId}/subscription/history`

人工授予输入固定包含：

- 活动套餐版本、计费周期、开始时间、到期时间。
- 需要保留/绑定的 Provider 列表。
- 必填操作原因和请求版本号。

事务规则：

- 锁定目标用户及当前订阅，执行乐观版本检查。
- 无订阅时创建 `source=ADMIN_GRANT` 的订阅；已有订阅时更新当前版本和期限，但保留历史 grant/event。
- 根据套餐槽位上限同步槽位。未超限且 Provider 相同的绑定保留原 `bound_at/next_rebind_at`；新增绑定生成时间；被移除或超额槽位冻结，不删除对应研究池。
- 降级或缩短期限前，UI 和 API 必须展示影响摘要并要求明确确认。
- 所有变更写 `subscription_grants`、`subscription_events` 和管理审计。
- 列表明确展示“已用槽位/总槽位”、Provider、槽位状态、下次可换绑时间、各 Provider 池已用量/容量。

### 4.7 全局长富Pro配置

新增：

- `changfu-backend/packages/model-provider/src/postgresOfficialModelConfigRepository.ts`
- `changfu-backend/packages/model-provider/src/modelHttpClient.ts`
- `changfu-backend/apps/admin/src/routes/officialModel.ts`

修改：

- `changfu-backend/apps/decision-worker/src/server.ts`
- `changfu-backend/packages/model-provider/src/credentialCrypto.ts`
- `changfu-backend/packages/model-provider/src/endpointSecurity.ts`

接口：

- `GET /api/v1/admin/official-model`
- `POST /api/v1/admin/official-model/versions`
- `PUT /api/v1/admin/official-model/versions/{configId}`
- `POST /api/v1/admin/official-model/versions/{configId}/test`
- `POST /api/v1/admin/official-model/versions/{configId}/activate`
- `POST /api/v1/admin/official-model/versions/{configId}/retire`
- `POST /api/v1/admin/official-model/versions/{configId}/rollback`

规则：

- 配置字段为显示名、协议、HTTPS Endpoint、模型 ID、API Key、启用状态。
- API Key 使用现有 `CHANGFU_MODEL_CREDENTIAL_KEY` 做 AES-256-GCM 加密；读取只返回已配置状态和末四位。
- 修改非密钥字段时可留空保留旧密钥；新建版本必须提交密钥。
- Endpoint 每次测试和调用前执行 HTTPS、DNS 解析、私网/环回/保留地址拦截，禁止重定向。
- 测试请求只发送固定最小探针，不带用户、账户、行情、Prompt 或交易数据；限制 15 秒和小响应体。
- 仅测试成功且测试对应的配置内容未变化时允许激活。
- 激活在事务内将旧 ACTIVE 改为 RETIRED、新版本改为 ACTIVE；保留完整历史，可一键复制旧版本并重新测试后回滚。
- Worker 每次模型运行从 PostgreSQL读取活动官方配置，实现无需发布的热切换；若数据库尚无 ACTIVE 配置，保留 `CHANGFU_ARK_*` 环境变量作为迁移期兜底。
- 普通对话/交易决策和 SELL PUT 报告统一使用 `modelHttpClient.ts`，保证协议、超时、大小限制、日志脱敏和配置来源一致。
- 用户级第三方模型优先级保持现有规则：用户明确选择有效第三方配置时使用第三方；选择 `OFFICIAL` 或未指定时使用当前活动长富Pro。

### 4.8 Admin Web

新增独立前端工程：

- `changfu-backend/admin-web/package.json`
- `changfu-backend/admin-web/vite.config.ts`
- `changfu-backend/admin-web/tsconfig.json`
- `changfu-backend/admin-web/src/main.tsx`
- `changfu-backend/admin-web/src/App.tsx`
- `changfu-backend/admin-web/src/api/client.ts`
- `changfu-backend/admin-web/src/auth/AuthGate.tsx`
- `changfu-backend/admin-web/src/layout/AdminShell.tsx`
- `changfu-backend/admin-web/src/pages/UsersPage.tsx`
- `changfu-backend/admin-web/src/pages/UserDetailDialog.tsx`
- `changfu-backend/admin-web/src/pages/PlansPage.tsx`
- `changfu-backend/admin-web/src/pages/SubscriptionsPage.tsx`
- `changfu-backend/admin-web/src/pages/OfficialModelPage.tsx`
- `changfu-backend/admin-web/src/styles.css`

界面约束：

- 默认进入用户管理，不制作营销落地页。
- 左侧固定窄导航：用户与订阅、套餐目录、长富Pro；用户详情弹窗集中管理套餐与槽位，顶部显示当前管理员和退出入口。
- 使用高密度金融工作站布局，内容铺满，无装饰性大卡片。
- 表格固定列宽、斑马纹、服务端分页；超宽内容在表格区域横向滚动，不能撑开侧栏。
- 用户、套餐版本、订阅和模型详情使用独立弹窗，不使用行内展开。
- 操作与结果分离：列表展示摘要，点击查看详情和历史。
- 内部枚举全部映射为严谨中文，不直接显示 `ACTIVE/FLAGSHIP` 等技术值。
- API Key 永不回显；只显示固定掩码和末四位。
- 停用用户、发布/退役套餐、缩短订阅、减少槽位、激活模型均需二次确认并展示影响摘要。
- 所有加载、空数据、校验失败、并发冲突、无权限和服务不可用状态都有明确中文反馈。

### 4.9 Admin API 契约

新增：

- `changfu-contracts/openapi/changfu-admin-v1.yaml`
- `changfu-contracts/schemas/admin-user.schema.json`
- `changfu-contracts/schemas/admin-plan.schema.json`
- `changfu-contracts/schemas/admin-subscription.schema.json`
- `changfu-contracts/schemas/official-model-config.schema.json`

修改：

- `changfu-contracts/scripts/check-contracts.mjs`
- `changfu-contracts/README.md`

契约要求：

- 所有对象 `additionalProperties: false`。
- 分页固定返回 `items/page/pageSize/total`。
- 写接口要求 `Idempotency-Key`、CSRF 和期望版本。
- 密码、Session Token、CSRF Token hash、API Key 密文和明文不得出现在响应 Schema。
- 错误统一返回稳定 code、中文 title、requestId，不泄漏数据库实现。

### 4.10 构建、部署与运行

修改：

- `changfu-backend/package.json`
- `changfu-backend/package-lock.json`
- `changfu-backend/tsconfig.json`
- `changfu-backend/deploy/volcano/Dockerfile.vefaas`
- `changfu-backend/deploy/volcano/env/.env.cloud.example`
- `changfu-backend/deploy/volcano/scripts/build-and-push-image.sh`
- `changfu-backend/deploy/volcano/scripts/configure-apig.sh`
- `changfu-backend/deploy/volcano/scripts/release-from-deploy-host.sh`
- `changfu-backend/deploy/volcano/scripts/verify-deployment.sh`
- `changfu-backend/deploy/volcano/README.md`

新增：

- `changfu-backend/deploy/volcano/run-admin.sh`

实施：

- Backend workspace 增加 Admin Web 的 React/Vite/lucide 依赖和独立构建命令。
- Docker build 阶段同时构建 Admin API 和 Admin Web；`admin` target 只包含生产依赖、编译后 API、静态资源和启动脚本。
- 构建脚本新增不可变 `-admin` 镜像。
- APIG 脚本继续默认 dry-run，新增 `changfu-admin` service/upstream/route 计划；只有显式设置 APPLY 才创建资源。
- Release 脚本验证函数名为 `changfu-admin`，迁移和权限成功后依次发布 Worker、Gateway、Admin。
- Admin Function 环境变量至少包含：
  - `CHANGFU_ADMIN_DATABASE_URL`
  - `CHANGFU_ADMIN_INITIAL_PASSWORD`
  - `CHANGFU_MODEL_CREDENTIAL_KEY`
  - `CHANGFU_ADMIN_COOKIE_SECURE=true`
  - Session 绝对/空闲 TTL
- 发布完成后验证 Admin health/ready、未登录 API 返回 401、静态页面可加载、现有 Gateway/Worker readiness 不回退。

### 4.11 架构文档同步

修改：

- `.trae/documents/changfu_desktop_architecture_plan.md`
- `changfu-backend/README.md`

补充管理端身份边界、数据库权威套餐目录、人工授予状态机、全局长富Pro配置优先级、密钥管理、部署拓扑和回滚规则。桌面端无需新增一级导航，也不改变现有六项主导航和第三方模型入口规则。

## 五、失败模式与边界处理

- Admin Secret 缺失且数据库无管理员：Admin readiness 返回失败，不创建弱默认密码。
- 管理员已存在：启动不覆盖密码，不重复播种。
- 用户名冲突：事务回滚并返回明确冲突，不产生孤立 profile。
- 用户停用：立即撤销所有会话；历史订阅、槽位、交易门禁和审计数据保留。
- 两名管理员并发编辑：期望版本不匹配返回 409，禁止后写覆盖先写。
- 套餐草稿字段不完整：不能发布。
- 活动套餐退役：只停止新购/新授予，不让现有权益失效。
- 套餐降级导致超槽：必须显式提交保留 Provider，未选择则拒绝。
- 人工授予事务部分失败：用户订阅、槽位、grant 和事件全部回滚。
- 模型测试失败：草稿保留，旧 ACTIVE 配置继续服务。
- 模型激活时配置已改变：拒绝激活并要求重新测试。
- 数据库活动模型配置暂时不可读：记录脱敏错误；迁移期可使用环境变量兜底，不读取未测试草稿。
- API Key 更新、测试、激活和调用全过程不写日志、不回显、不进入浏览器缓存。

## 六、Verification

### 6.1 自动化测试

Backend：

- 管理员首次播种、重复启动不覆盖、强制改密。
- 密码哈希、登录限速、锁定、Session 过期/撤销、CSRF 和 Origin 校验。
- 普通用户 Token 不能访问 Admin API，管理员 Cookie 不能访问桌面用户 API。
- 用户创建双表原子性、用户名冲突、编辑、重置密码、停用及会话撤销。
- 套餐草稿校验、版本递增、单活动版本、发布、退役和历史订阅连续性。
- 人工授予首次开通、调整、冻结、恢复、取消、并发冲突和槽位降级。
- 长富Pro密钥加密、读取脱敏、SSRF 防护、测试失败不切换、成功原子切换和回滚。
- 普通模型运行与 SELL PUT 都读取同一活动官方配置；用户级第三方模型路由优先级不变。
- 迁移 checksum、schema privacy、数据库权限和 OpenAPI contract 检查。
- `changfu-backend` 总行覆盖率继续保持高于 90%，关键认证、订阅授权和凭据加密模块达到 100% 分支覆盖。

Admin Web：

- TypeScript、lint、production build。
- API client 对 401、403、409、422、503 的统一处理。
- 表单校验、分页、筛选、详情弹窗、二次确认、API Key 不回显。
- Playwright 覆盖登录强制改密、创建用户、发布套餐版本、人工授予套餐、查看槽位、模型测试并激活、停用用户。

### 6.2 本地集成验收

1. 在临时 PostgreSQL 应用 000-011 迁移和两类最小权限 grant。
2. 启动 Worker、Gateway、Admin，确认三者 readiness。
3. 使用部署 Secret 首次播种 `admin`，验证数据库只有哈希且登录后必须改密。
4. 创建测试用户，使用 macOS 客户端完成登录，确认用户归属和设备注册正常。
5. 创建三档套餐的新草稿版本并发布，确认 Gateway 无重启即可返回新活动目录。
6. 人工授予套餐并绑定 Futu/Longbridge，确认 macOS 套餐页和 Provider 池看到一致槽位。
7. 停用用户，确认既有 access/refresh token 失效，但交易门禁历史值未被默认关闭或覆盖。
8. 创建错误模型草稿，确认测试失败且旧模型继续工作；再创建正确配置，测试成功后激活并验证普通模型和 SELL PUT 均使用新版本。
9. 检查 PostgreSQL 与日志，确认不存在明文管理员密码、API Key、Authorization、用户金融上下文。

### 6.3 UI 验收

- 使用 Playwright 截图检查 1440×900、1280×800 和 390×844。
- 验证固定导航宽度、表格列宽、斑马纹、横向滚动、弹窗层级和所有中文文案。
- 验证长用户名、长模型 ID、长 Endpoint、无数据、错误和加载状态不溢出、不遮挡。

### 6.4 发布验收与回滚

- 仅在指定部署机 `ECS-0EJj-deploy` 构建和发布不可变镜像。
- APIG 先生成 dry-run 产物，人工核对后再 APPLY。
- 数据库先迁移、再授权，随后发布 Worker、Gateway、Admin。
- 发布后验证旧桌面登录、订阅读取、模型运行和 SELL PUT 无回归。
- Admin 回滚只切换 Admin Function revision；官方模型误配置通过激活上一已测试版本回滚，无需发布 Worker。
- 数据库迁移只做向前兼容扩展，不删除旧表、历史套餐版本、订阅、订单或模型配置。
