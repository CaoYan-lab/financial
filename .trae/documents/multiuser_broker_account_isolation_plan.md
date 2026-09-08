# 多用户账户体系与券商数据隔离实施方案

## Summary

目标是在不改动现有 Futu、Longbridge 核心业务模块的前提下，为云端工作台增加真正的多用户体系：

* 当前单一管理员账号迁移为 `owner`，显示名为 `caoshaokun`。

* 新用户只能由 owner 在管理界面创建，不开放公开注册；首次登录强制修改临时密码。

* Futu 继续使用 ECS 上唯一 OpenD 和当前真实账户，但所有账户数据默认在服务端完全隐藏。

* 仅 owner 可以进入 Futu；每次登录后仍为锁定状态，输入独立 Futu 二次密码后，当前浏览器获得 10 分钟滑动解锁。

* 每位普通用户只能绑定一个自己的 Longbridge 活动账户，凭据由本人录入，owner 不能查看凭据、资产、持仓、订单或策略历史。

* Longbridge 账户读取、策略评估、待确认订单、提交、撤单、历史和监管均按应用用户及账户绑定隔离。

* 多用户 Longbridge 实盘先进入影子模式；每个用户独立完成只读与影子验收后，再逐户开启真实交易门禁。

* 全部新业务代码放在独立 `multiuser` 子目录；现有 Futu/Longbridge 引擎、路由、页面、hooks 和持久化类不修改，只允许云 Web、云 Worker 和云前端壳三个入口增加最小挂载。

## Longbridge 官方文档结论

已核对：

* 官方 Node SDK README：`node_modules/longbridge/README.md`

* OAuth 类文档：<https://longbridge.github.io/openapi/nodejs/classes/OAuth.html>

* Config 类文档：<https://longbridge.github.io/openapi/nodejs/classes/Config.html>

* TradeContext 类文档：<https://longbridge.github.io/openapi/nodejs/classes/TradeContext.html>

* Longbridge CLI 0.23.3 帮助及官方源码：

  * <https://github.com/longbridge/longbridge-terminal/blob/main/src/auth.rs>

  * <https://github.com/longbridge/longbridge-terminal/blob/main/src/secure_storage.rs>

结论：

1. **可以同时操作多个 Longbridge 账户**，但必须为每个账户创建独立的认证配置和 `TradeContext`，不能复用当前进程级单例。
2. 当前项目的账户、持仓、订单及实盘交易 SDK 链路使用 Legacy API Key 模式：

   * `Config.fromApikey(appKey, appSecret, accessToken)`

   * 因此只提供一个 Access Token 不够；每个绑定必须提供完整的 App Key、App Secret、Access Token。
3. 当前项目的研究、资讯等 CLI 链路使用 OAuth 登录态；它与上述账户及订单 SDK 链路是两套独立认证路径。
4. 官方推荐 OAuth 2.0。Node SDK 的 `OAuth.build(clientId)` 默认按 `clientId` 缓存令牌：

   * `~/.longbridge/openapi/tokens/<clientId>`

   * 同一个 Worker、同一个 `clientId` 直接复用缓存时无法安全区分多个应用用户。
5. Longbridge CLI 0.23.3 的实际行为与 Node SDK 默认缓存不同：

   * 每个 `HOME` 只有一个 `~/.longbridge/openapi/cli-registration` 和一个加密的 `~/.longbridge/openapi/cli-auth`。

   * CLI 没有 `profile`、`account` 或 Token 选择参数；重新登录会替换当前 HOME 的登录态。

   * `cli-auth` 使用机器 ID 派生密钥进行 AES-256-GCM 加密，不适合在本地磁盘非持久、实例可能重建的 veFaaS 中直接复制复用。

   * 理论上可以为每个用户启动独立 HOME 的 CLI 子进程，但这只是进程/文件隔离手段，不是可靠的云端多租户令牌存储方案。
6. 本期按用户确认采用完整凭据绑定：

   * 每个用户独立加密保存一组完整凭据。

   * Worker 按 `binding_id` 创建并缓存独立 `Config/QuoteContext/TradeContext`。

   * CLI 继续只承担共享研究/资讯降级能力，不能用于用户账户、持仓、订单或交易。
7. 后续如切换 OAuth，必须增加专用 OAuth 回调、每用户完整 Token Bundle（Access Token、Refresh Token、Client ID、过期时间）存储和刷新体系；不得复用当前 CLI 单 HOME 登录态。

## Current State Analysis

### 1. 登录与用户

* `deploy/volcano/pg/schema.sql`

  * 已有 `cloud_users`，支持多行用户，但没有角色、启停状态、首次改密或券商绑定。

* `api/cloud/auth/authService.ts`

  * 登录已按用户名查库并用 scrypt 校验。

  * 当前仅缺用户管理与授权模型，不需要推翻基础密码校验。

* `api/cloud/auth/jwt.ts`

  * JWT 已包含用户 ID `sub` 和 `username`，足以作为新模块识别用户的可信入口。

* `api/cloud/http/cloudWebApp.ts`

  * 所有 `/api` 已经过 `requireAuth`。

  * 当前没有登录后的用户角色与资源归属校验。

* 浏览器登录 Cookie `fa_session` 已天然按浏览器配置文件隔离；同一浏览器标签页共享，不同浏览器互不共享。

### 2. Futu 隐私现状

* `src/stores/uiStore.ts` 的 `assetPrivacyHidden` 只是 `localStorage` 显示开关。

* `src/components/common/AssetPrivacyToggle.tsx` 只在前端把金额替换为掩码。

* Futu 完整账户、持仓、订单和 Worker 快照已经到达浏览器，因此当前方案不能保护 caoshaokun 的账户数据。

* 云端 Futu 数据入口分散在：

  * `/api/live-trading/*`

  * `/api/account/*`

  * `/api/source/status`

  * `/api/cloud/worker-status*`

  * Futu 报告、订单详情、托管订单和历史接口

* 安全边界必须在 `fin-web` 服务端完成，不能继续依赖前端隐藏。

### 3. Longbridge 单账户现状

* `api/longbridge/longbridgeCli.ts`

  * 研究、资讯等 CLI 调用固定使用 `.tools/longbridge-home`，因此所有调用共享一套 OAuth 登录态。

  * 当前 CLI 队列、限流和 HOME 都是进程级配置，不具备用户或账户键。

* `api/longbridge/longbridgeSdkGateway.ts`

  * 账户、持仓、订单及实盘链路从全局环境变量读取一组 Legacy API Key 凭据。

  * `Config`、`QuoteContext`、`TradeContext`、账户缓存和探测缓存均为进程级单例。

* `api/longbridge/longbridgeRealtimeSubscriptionService.ts`

  * 单一 SDK 行情上下文和单一订阅缓存。

* `api/longbridge/longbridgeLiveTradingEngine.ts`

  * 导出全局单例，引擎状态、账户、候选池和运行定时器不含用户键。

* `api/longbridge/longbridgePersistence.ts`

  * 历史表和内存缓存无 `user_id` / `binding_id`。

* `api/cloud/jobs/jobHandlers.ts`

  * Longbridge 任务只带业务参数；`requestedBy` 仅用于日志，不决定账户上下文。

* `cloud_worker_status` 仅有全局 `longbridge_live` 快照，不能直接暴露给多用户。

### 4. 隔离约束

以下现有核心模块保持不变：

* `api/live/**`

* `api/longbridge/**`

* `api/routes/**`

* `src/pages/**`

* `src/hooks/**`

* `src/components/**`

* 现有历史表和现有 Futu/Longbridge 数据不删除、不改写

只允许最小修改：

1. `api/cloud/http/cloudWebApp.ts`

   * 挂载多用户公开认证路由、登录后策略中间件和私有路由。
2. `api/cloud/worker/workerServer.ts`

   * 在当前唯一 leader 生命周期内启动/停止多用户 Worker runtime。
3. `src/cloud/CloudApp.tsx`

   * 在现有 `App` 外包裹多用户 Shell、管理入口、Futu 二次验证弹窗和 Longbridge 绑定弹窗。

数据库使用独立 SQL 文件和独立 schema，不修改现有表定义：

* `deploy/volcano/pg/multiuser_schema.sql`

* PostgreSQL schema：`multiuser`

## Target Architecture

```text
浏览器 A / 用户 A                         浏览器 B / 用户 B
        | fa_session + 可选 fa_futu_unlock       | 独立 Cookie
        +--------------------+--------------------+
                             |
                         fin-web
                    requireAuth（现有）
                             |
             multiuser security context（新增）
             /                |                 \
      用户/角色管理      Futu 服务端门禁       Longbridge 租户路由
                         | owner + 二次解锁      | user_id + binding_id
                         |                       |
                  现有 Futu 路由            multiuser.jobs
                  现有 Worker 快照               |
                                            fin-worker leader
                                      multiuser worker runtime
                                        | 独立 SDK Context
                                        | 独立策略状态
                                        | 独立历史/订单
                                        v
                                  用户自己的 Longbridge 账户
```

### 安全原则

* 身份来自已验签 JWT 的 `sub`，禁止接受前端传入的 `user_id` 作为授权依据。

* 所有 Longbridge 任务由 Web 根据当前用户写入 `user_id` 和 `binding_id`；Worker 再次查库确认归属。

* 券商凭据不进入 JWT、不进入任务 payload、不进入日志、不返回前端。

* 任一权限、数据库、解密或上下文校验失败时 fail closed，不回落到旧全局账户。

* owner 只能管理用户和查看连接健康状态，不能查看其他用户的 Longbridge 私有数据。

## Proposed Changes

### 1. 独立数据库 schema

新增文件：`deploy/volcano/pg/multiuser_schema.sql`

新增表：

#### `multiuser.user_profiles`

* `user_id BIGINT PRIMARY KEY REFERENCES cloud_users(id)`

* `display_name TEXT`

* `role TEXT CHECK (role IN ('owner', 'member'))`

* `active BOOLEAN`

* `must_change_password BOOLEAN`

* `created_by BIGINT`

* `created_at / updated_at`

迁移规则：

* 部署前必须配置 `MULTIUSER_OWNER_USERNAME`，值对应当前唯一管理员用户名。

* 幂等脚本把该用户设为 `owner`，显示名设为 `caoshaokun`。

* 如果用户名不存在或发现多个 owner，迁移直接失败，不自动猜测。

#### `multiuser.broker_connections`

* `id UUID PRIMARY KEY`

* `user_id BIGINT`

* `platform TEXT`，本期仅 `longbridge`

* `credential_source TEXT`：`legacy_env | encrypted_bundle`

* `credential_ciphertext / iv / auth_tag`

* `key_version`

* `account_fingerprint`

* `status`：`pending | verified | invalid | disabled`

* `token_expires_at`

* `last_verified_at`

* `created_at / updated_at`

* 唯一约束：每个用户最多一个活动 Longbridge 绑定

owner 的现有 Longbridge 绑定写为 `legacy_env`：

* 不复制当前环境变量密钥到数据库。

* 只允许 owner 使用。

* 原历史、订单和策略状态继续归属 owner。

#### `multiuser.futu_owner_secret`

* `owner_user_id PRIMARY KEY`

* `password_hash`

* `updated_at`

规则：

* 使用独立 salt 的 scrypt 哈希。

* 二次密码至少 12 位，不能与当前登录密码相同。

* 初次设置及重置必须同时验证 owner 当前登录密码。

* 未设置二次密码时 Futu 始终锁定。

#### `multiuser.futu_unlock_sessions`

* `id UUID PRIMARY KEY`

* `owner_user_id`

* `token_hash`

* `last_seen_at`

* `expires_at`

* `revoked_at`

* `ip_hash / user_agent_hash`

规则：

* 浏览器仅保存随机 opaque Cookie `fa_futu_unlock`。

* Cookie：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600`。

* 每次访问受保护 Futu API 时滑动续期 10 分钟。

* 退出登录、主动锁定、用户禁用、二次密码重置时立即撤销。

#### Longbridge 多租户表

* `multiuser.longbridge_jobs`

* `multiuser.longbridge_engine_state`

* `multiuser.longbridge_worker_snapshots`

* `multiuser.longbridge_events`

* `multiuser.longbridge_managed_orders`

* `multiuser.longbridge_order_events`

所有表必须包含：

* `user_id`

* `binding_id`

* 对应资源 ID

* 创建/更新时间

索引和唯一键都把 `user_id, binding_id` 放在前缀；任何查询不得缺少租户条件。

#### `multiuser.security_audit`

记录：

* 用户创建、禁用、重置密码

* Longbridge 绑定、验证、替换、断开

* Futu 二次密码设置、成功/失败解锁、主动锁定、超时

* 策略启停、订单确认、提交、撤单和门禁拒绝

只记录资源 ID、结果、IP、User-Agent 摘要，不记录密码、Token、App Secret 或完整账户资产。

### 2. 多用户认证与权限模块

新增目录：

```text
api/cloud/multiuser/
├── auth/
│   ├── multiUserAuthService.ts
│   ├── passwordService.ts
│   ├── profileStore.ts
│   └── securityContext.ts
├── http/
│   ├── publicAuthRouter.ts
│   ├── privateRouter.ts
│   └── brokerPolicyMiddleware.ts
├── audit/securityAuditStore.ts
└── types.ts
```

行为：

* 新公开路由在旧 `/api/auth/login|logout` 之前挂载并接管同一路径。

* 登录成功前检查 `user_profiles.active`。

* `must_change_password=true` 时，只允许：

  * `/api/auth/me`

  * `/api/multiuser/password/change`

  * `/api/auth/logout`

* owner API：

  * `GET /api/multiuser/users`

  * `POST /api/multiuser/users`

  * `PUT /api/multiuser/users/:id/status`

  * `POST /api/multiuser/users/:id/reset-password`

* 不提供公开注册，不物理删除用户。

* 临时密码首次登录必须修改；密码统一 scrypt 哈希。

### 3. Futu 服务端二次验证

新增目录：

```text
api/cloud/multiuser/futu/
├── futuAccessPolicy.ts
├── futuStepUpService.ts
├── futuProtectedRoutes.ts
└── futuResponseRedactor.ts
```

API：

* `GET /api/multiuser/futu/access`

  * 返回 `forbidden | locked | unlocked | setup_required`，不返回账户内容。

* `POST /api/multiuser/futu/secondary-password`

  * owner 首次设置或重置二次密码。

* `POST /api/multiuser/futu/unlock`

  * 校验二次密码并创建当前浏览器短时会话。

* `POST /api/multiuser/futu/lock`

  * 撤销当前浏览器解锁。

服务端保护范围：

* `/api/live-trading/**`

* `/api/account/**`

* `/api/source/status`

* Futu 订单、详情、托管订单、策略历史、待确认订单

* 可能包含 Futu 快照的 `/api/cloud/worker-status*`

* 报告与机会接口中包含账户/持仓/订单上下文的字段

响应语义：

* 非 owner：`403 FUTU_FORBIDDEN`

* owner 未解锁：`423 FUTU_LOCKED`

* 未设置二次密码：`428 FUTU_STEP_UP_SETUP_REQUIRED`

* 解锁后：放行到现有 Futu 路由，现有 Futu 代码不修改

必须保证：

* 未解锁时浏览器网络响应中不存在账户 ID、总资产、购买力、持仓、订单、成交、费用或策略账户上下文。

* 原 `localStorage` 资产遮罩只保留为视觉辅助，不再承担安全职责。

* 原始 Worker 快照不直接返回浏览器；通过多用户过滤器输出最小健康状态。

### 4. Longbridge 凭据保险箱

新增目录：

```text
api/cloud/multiuser/longbridge/
├── credentialVault.ts
├── connectionStore.ts
├── contextRegistry.ts
├── accountService.ts
├── orderService.ts
├── tenantPersistence.ts
├── tenantEngine.ts
├── tenantScheduler.ts
└── tenantJobRuntime.ts
```

凭据规则：

* 环境变量新增 `MULTIUSER_CREDENTIAL_MASTER_KEY`：

  * 32 字节随机值，Base64 编码。

  * Web 与 Worker 使用同一密钥，以 veFaaS Secret 注入。

* 使用 AES-256-GCM，每条绑定独立随机 IV 和认证标签。

* 数据库保存 `key_version`，预留密钥轮换。

* API 永不返回凭据明文；连接页只显示验证状态、更新时间和脱敏标识。

绑定流程：

1. 用户本人输入 App Key、App Secret、Access Token。
2. Web 只在内存中短暂持有明文，先执行 SDK 只读初验：

   * `accountBalance()`

   * `stockPositions()`

3. 初验成功后以 `pending` 状态加密入库，并创建不含凭据的
   `multiuser.longbridge.verify_connection` 任务。
4. Worker 解密当前 pending 绑定，通过现有订单子进程和云端订单代理执行
   `todayOrders()` / 历史订单读取终验：

   * 终验成功：原 verified 绑定转 disabled，pending 原子切换为 verified。

   * 终验失败：pending 转 invalid，原 verified 绑定继续可用。
5. Web 不直接调用云端订单接口；所有订单读取、详情、撤单和提交均由 Worker
   子进程按当前绑定注入临时凭据。
6. Worker 首次业务使用时按 `binding_id` 创建独立上下文。

### 5. Longbridge 租户上下文

`contextRegistry.ts`：

* Key：`binding_id`

* Value：独立 `Config / QuoteContext / TradeContext`

* 使用 `Config.fromApikey(appKey, appSecret, accessToken)`，禁止写入 `process.env`。

* 每个绑定拥有独立账户缓存、Token 健康状态和错误熔断状态。

* 设置 TTL/LRU 上限，失效、替换凭据或用户禁用时立即驱逐。

* 订单子进程只注入当前绑定解密后的临时环境变量。

* 凭据不得写入 `cloud_jobs` 或 `multiuser.longbridge_jobs`。

owner 兼容：

* owner 的 `legacy_env` 绑定继续委托现有 Longbridge 单例和现有历史。

* 多用户路由仅在 owner 请求时允许回落到旧 Longbridge 路由。

* member 请求禁止任何形式回落，异常时返回 503/403。

### 6. Longbridge 完整实盘隔离

新租户引擎不能调用以下全局单例：

* `longbridgeLiveTradingEngine`

* `longbridgePersistence`

* `longbridgeOrderQueueService`

* `longbridgeRealtimeStore`

新增租户引擎要求：

* 每个用户一个活动绑定、一个独立引擎状态。

* 行情事实数据允许共享只读缓存，但账户、持仓、购买力、订单和风控上下文必须来自当前用户 `TradeContext`。

* 候选池、待确认订单、提交订单、拒绝订单、监管事件均写入 `multiuser` schema。

* ID 必须包含或关联 `user_id + binding_id`。

* Worker 调度默认串行或有限并发，避免多账户放大 Longbridge 10 次/秒限制和 LLM 请求。

* owner 与 member 必须复用同一套市场时段策略，不允许租户引擎自行放宽：

  * 港股仅在 Longbridge 交易日历确认当日为交易日后评估；等待开市、午休、收盘、周末和节假日跳过，竞价、早市、午市及收市竞价按统一 LLM 门禁执行。

  * 美股在 Longbridge 交易日历确认对应 session date 为交易日后，区分盘前、盘中、盘后和夜盘；盘前/盘中/盘后允许评估，订单时段分别映射为 `ETH/RTH/ETH`。

  * 美股夜盘是否评估必须读取与 owner 相同的 `disableUsOvernightLlm` 运行时开关；默认关闭夜盘 LLM。即使开启夜盘研究，也不得生成或提交真实订单。

  * 美股周末、节假日或休市始终跳过评估，不受夜盘开关影响。夜盘跨日时以所属的下一个交易日判断，不得仅按服务器工作日推断。

  * 市场日历、行情状态或时区解析失败时 fail closed：仅输出实时运行状态和结构化日志，不落策略信号或逐标的跳过记录，不得发送 LLM 请求、生成候选或创建待确认订单。

  * SDK `tradeStatus` 表示证券状态而非交易所时段，不得把 `Normal=0` 直接当成盘中或休市；证券停牌、退市、熔断等非正常状态直接跳过。

* 每个用户独立：

  * 启动/停止

  * 影子/实盘模式

  * 自动提交开关

  * 自动撤单开关

  * 风控参数

  * 最后运行时间与错误状态

* 任何提交/撤单前重新加载绑定归属、用户状态、连接状态和该用户交易门禁。

#### 市场状态统一规则（2026-09-08 补充）

* admin Longbridge 与 member Longbridge 必须调用同一个
  `longbridgeMarketSessionService`，使用 Longbridge `tradingDays()`、交易所时区和
  美股夜盘所属交易日计算市场时段。

* Longbridge 行情中的 `tradeStatus` 仅表示证券是否正常，不得用于 Banner、
  模型评估门禁或订单提交时段判断。

* Futu 的 `get_market_state()` 结果必须再经过 Futu `request_trading_days()` 校验：
  非交易日一律覆盖为休市，禁止把节假日返回的盘前或盘后状态当成可评估时段。

* Futu 市场状态接口必须为请求股票池中的每个标的返回结果；OpenD 未返回的标的
  显式标记为状态不可用并失败关闭，不得因 30 秒缓存命中而遗漏新增标的。

* admin 与 member 的 Dashboard 状态刷新上限均为 30 秒；Worker 心跳中的 admin
  状态每 15 秒重新计算，页面每 30 秒刷新。引擎每轮评估和真实订单提交前必须
  重新读取交易日历，不能只依赖 Dashboard 或订阅缓存。

* Worker 对大型看板快照执行体积裁剪时，必须完整保留
  `evaluationStatus.items`；历史信号、候选和订单等大数组可按既有上限裁剪，
  但不得因此让 Futu 或 Longbridge 的 20 个股票池状态在页面缺项。

#### Longbridge 订单代理一致性（2026-09-08 补充）

* admin 与 member 的订单列表、详情、提交和撤单统一调用同一组 SDK 子进程，并
  统一通过 `buildLongbridgeOrderChildEnvironment()` 构造环境。

* 云端 `CLOUD_MODE=1` 且非本地直连时，两条链路都必须注入相同的
  `LONGBRIDGE_ORDER_PROXY_URL` 到 `HTTPS_PROXY`、`HTTP_PROXY`，并设置
  `NO_PROXY=''`，确保经过 ECS 上的 LongbridgeRelay/HeySocks 出口。

* member 子进程只比 admin 多覆盖当前绑定的 App Key、App Secret、Access Token，
  不改变代理选择；真实提交时仅对子进程设置
  `LONGBRIDGE_LIVE_TRADING_ENABLED=true`。

* 云端缺少订单代理时 admin 与 member 必须同时失败关闭，禁止 member 回退直连。
  Worker 健康响应公开布尔值 `longbridgeOrderProxyConfigured`，不得返回代理地址。

* 发布脚本在存在 Worker 镜像时强制要求 `LONGBRIDGE_ORDER_PROXY_URL`；启用多用户时
  同时强制要求 `MULTIUSER_CREDENTIAL_MASTER_KEY`，任一缺失都在更新云函数前失败。

#### Longbridge 港股交易单位（2026-09-08 补充）

* 港股不得固定假设为每手 100 股。admin 与 member 均通过 Longbridge
  `QuoteContext.staticInfo()` 读取证券真实 `lotSize`；读取失败时港股按 100 股
  失败关闭，美股按 1 股处理。

* Prompt 必须向模型明确当前标的 `lotSize`。港股开仓 `BUY/SELL_SHORT` 的
  `orderQuantity` 必须是每手股数的正整数倍；若购买力无法覆盖至少一手，必须
  返回 `HOLD`。美股继续按正整数股处理。

* 模型输出解析、策略硬风控和真实订单提交前必须分别复核交易单位。任何旧订单或
  绕过提示词生成的不合规港股数量均禁止提交；平仓卖出不强制整手，以允许处理碎股。

#### 港美股币种与 Futu 交易单位（2026-09-08 补充）

* 混合股票池不得复用单一 USD 账户快照计算全部标的。Longbridge admin、Longbridge
  member 和 Futu 均按标的市场选择账户口径：美股使用 USD，港股使用 HKD；Prompt、
  名义金额、权益、购买力、费用和后端硬风控必须处于同一币种。

* 禁止将港股价格计算出的 HKD 名义金额直接与 USD 购买力比较，也禁止通过固定汇率
  规避账户币种读取。Longbridge 使用 `accountBalance('HKD')` 获取港股账户快照，
  Futu 使用 `accinfo_query` 的 HKD 专用字段。

* Futu 从 `get_market_snapshot()` 的 `lot_size` 获取真实每手股数，并在 Prompt、
  模型输出解析、策略硬风控及真实提交前复核。港股每手股数不可确认时失败关闭；
  美股继续按整数股处理。

#### 多用户实盘门禁审批（2026-09-08 补充）

* owner 用户管理页提供成员级“批准实盘/关闭实盘”操作。

* 批准前必须确认成员启用且 Longbridge 绑定状态为 `verified`；批准后写入
  `shadow_verified_at`、`mode='live'` 和 `live_trading_enabled=true`，但保持
  `auto_submit_enabled=false`，自动下单仍由成员本人单独开启。

* 关闭成员实盘权限时同时关闭 `live_trading_enabled` 和
  `auto_submit_enabled`，并写安全审计。

* 设置接口必须采用局部更新语义；成员只切换自动下单时，不得把已经批准的
  `live_trading_enabled` 误写为 `false`。

* 当成员已通过 owner 验收，并同时满足 `mode='live'`、
  `live_trading_enabled=true`、`auto_submit_enabled=true` 时，租户 Worker 在策略
  生成待确认订单后自动创建 `multiuser.longbridge.submit_order` 任务；任一条件
  不满足时只保留人工确认。

* 自动提交任务与人工确认任务进入同一执行路径，必须再次校验用户、绑定、三重
  门禁、订单归属和当前交易日历，然后才允许启动订单 SDK 子进程。

任务格式：

```json
{
  "job_type": "multiuser.longbridge.confirm",
  "user_id": "由服务端 JWT 得出",
  "binding_id": "服务端查询得到",
  "requested_by": "username",
  "payload": {
    "pending_order_id": "...",
    "confirmation_id": "..."
  }
}
```

Worker 必须忽略客户端直接提交的 `user_id` 或 `binding_id`。

### 7. 多用户 Web 路由

新增 `api/cloud/multiuser/http/privateRouter.ts`，在旧 `routeOverrides` 之前挂载。

Longbridge API 保持现有前端契约：

* owner + `legacy_env`：经安全检查后 `next()` 到原路由。

* member：由新租户路由响应。

* 未绑定：`428 LONGBRIDGE_CONNECTION_REQUIRED`。

* 绑定失效：`409 LONGBRIDGE_CONNECTION_INVALID`。

必须覆盖全部 `/api/longbridge/**`：

* 明确列入共享白名单的公共行情/研究接口才允许使用共享数据源。

* 账户、持仓、自选、订单、策略、历史、托管订单和状态快照全部按租户处理。

* 未识别的 Longbridge 路由对 member 返回 404，禁止回落到旧全局账户。

### 8. 多用户 Worker Runtime

新增目录：

```text
api/cloud/multiuser/worker/
├── multiUserWorkerRuntime.ts
├── tenantJobConsumer.ts
└── tenantHeartbeat.ts
```

集成：

* `api/cloud/worker/workerServer.ts` 仅增加启动/停止挂载。

* 只有获得现有 PostgreSQL advisory leader 锁的 Worker 才运行多用户 runtime。

* 使用独立 `multiuser.longbridge_jobs` 队列，不改现有 `cloud_jobs` 和 `jobHandlers.ts`。

* 心跳按 `user_id + binding_id` 写 `multiuser.longbridge_worker_snapshots`。

* owner 的原引擎继续由现有 Worker 管理；member 引擎只由新 runtime 管理。

### 9. 前端多用户 Shell

新增目录：

```text
src/multiuser/
├── MultiUserShell.tsx
├── stores/sessionPolicyStore.ts
├── api/multiUserApi.ts
├── components/UserMenu.tsx
├── components/UserManagementDialog.tsx
├── components/PasswordChangeDialog.tsx
├── components/FutuUnlockDialog.tsx
├── components/FutuLockButton.tsx
└── components/LongbridgeConnectionDialog.tsx
```

只修改 `src/cloud/CloudApp.tsx`：

* 登录后用 `MultiUserShell` 包裹现有 `<App />`。

* 不修改 `App.tsx`、现有页面、hooks 或组件。

全局 fetch 行为：

* `423 FUTU_LOCKED`：弹出 Futu 二次验证框；成功后仅重试原只读 GET 请求，写操作不自动重试。

* `428 FUTU_STEP_UP_SETUP_REQUIRED`：owner 进入设置流程。

* `403 FUTU_FORBIDDEN`：显示无权限页，不展示任何缓存内容。

* `428 LONGBRIDGE_CONNECTION_REQUIRED`：打开本人 Longbridge 绑定弹窗。

* `409 LONGBRIDGE_CONNECTION_INVALID`：显示重新验证入口。

* `401`：继续沿用现有自动返回登录页逻辑。

用户菜单：

* 所有人：修改密码、自己的 Longbridge 连接、退出。

* owner：额外显示用户管理、设置/重置 Futu 二次密码、主动锁定 Futu。

* owner 不能从管理界面进入其他用户的账户内容。

### 10. 最小入口修改清单

只允许以下原文件改动：

1. `api/cloud/http/cloudWebApp.ts`

   * 增加 multiuser public/private router 和 policy middleware 挂载。
2. `api/cloud/worker/workerServer.ts`

   * 在 leader 生命周期内启停 multiuser worker runtime。
3. `src/cloud/CloudApp.tsx`

   * 挂载 `MultiUserShell`。

不得修改：

* `api/live/**`

* `api/longbridge/**`

* `api/routes/**`

* `src/pages/**`

* `src/hooks/**`

* `src/components/**`

* `shared/**`

* 现有 PG 表、SQLite 文件和历史数据

如果实施中发现必须突破此白名单，应停止实施并回到方案评审，不得自行扩大范围。

## API and Failure Semantics

### 用户管理

* `GET /api/multiuser/session`

* `POST /api/multiuser/password/change`

* `GET /api/multiuser/users`（owner）

* `POST /api/multiuser/users`（owner）

* `PUT /api/multiuser/users/:id/status`（owner）

* `POST /api/multiuser/users/:id/reset-password`（owner）

### Longbridge 连接

* `GET /api/multiuser/longbridge/connection`

* `POST /api/multiuser/longbridge/connection/verify`

* `PUT /api/multiuser/longbridge/connection`

* `DELETE /api/multiuser/longbridge/connection`

### 通用错误

* `401 AUTH_REQUIRED`

* `403 ROLE_FORBIDDEN`

* `403 FUTU_FORBIDDEN`

* `423 FUTU_LOCKED`

* `428 PASSWORD_CHANGE_REQUIRED`

* `428 FUTU_STEP_UP_SETUP_REQUIRED`

* `428 LONGBRIDGE_CONNECTION_REQUIRED`

* `409 LONGBRIDGE_CONNECTION_INVALID`

* `503 BROKER_CONTEXT_UNAVAILABLE`

错误响应不得包含券商原始凭据、账户完整编号或其他用户身份信息。

## Assumptions & Decisions

* 已确认：当前管理员账号保留，迁移为 owner，显示名 `caoshaokun`。

* 已确认：owner 后台创建用户，使用临时密码，首次登录必须改密。

* 已确认：Futu 仅 owner 可访问，其他用户始终无权查看。

* 已确认：Futu 使用独立二次密码，当前浏览器 10 分钟无操作失效。

* 已确认：每个应用用户首期只能绑定一个活动 Longbridge 账户。

* 已确认：Longbridge 采用完整 App Key/App Secret/Access Token，不在本期实现 OAuth。

* 已确认：Longbridge 完整实盘链路按用户隔离。

* 已确认：owner 不可查看其他用户 Longbridge 数据或凭据。

* 已确认：用户本人录入凭据。

* 已确认：多用户实盘先影子、后逐户开启。

* 已确认：现有 Longbridge 账户和历史归 owner，保留旧存储，不迁表。

* 已确认：新增模块与现有代码目录隔离，只允许三个入口文件做最小挂载。

本期不包含：

* 公开注册、找回密码邮件、短信验证码。

* 一个用户绑定多个 Longbridge 活动账户。

* Longbridge 浏览器 OAuth。

* owner 代看其他用户账户。

* 多个 Futu OpenD 或多个 Futu 账户。

* 修改现有 Futu/Longbridge 引擎和页面。

## Security Verification

### Futu 数据泄漏测试

使用 member 会话逐一请求：

* `/api/live-trading/dashboard`

* `/api/live-trading/history/*`

* `/api/live-trading/futu-orders`

* `/api/account/dashboard`

* `/api/account/positions`

* `/api/source/status`

* `/api/cloud/worker-status`

预期：

* 全部为 403 或严格脱敏健康响应。

* 响应正文不得出现账户 ID、资产、购买力、持仓、订单、成交或费用。

使用 owner 未解锁会话重复请求：

* 预期 423，不返回原始数据。

owner 解锁后：

* 当前浏览器正常访问。

* 另一浏览器仍为 423。

* 10 分钟无操作后再次为 423。

* 主动锁定和退出立即失效。

### Longbridge 租户隔离测试

准备用户 A、B 及不同凭据：

* A 只能看到 A 的账户、持仓、订单、策略、历史和监管。

* B 只能看到 B 的数据。

* 篡改请求中的订单 ID、任务 ID、绑定 ID，必须返回 403/404。

* owner 用户管理接口只返回连接状态，不能返回 A/B 的资产和凭据。

* 数据库查询确认所有新记录都有正确 `user_id + binding_id`。

* 日志和任务 payload 中搜索 App Secret/Access Token，结果必须为空。

### 交易安全测试

* 新用户默认 `shadow`，即使全局实盘门禁开启也不能提交订单。

* 未完成只读验证、影子验收或逐户门禁审批时，确认接口必须被 Worker 拒绝。

* 订单确认使用唯一 `confirmation_id`，重复请求不可重复下单。

* 撤单必须验证订单属于当前 `user_id + binding_id`。

* 用户禁用或凭据替换后，现有上下文立即驱逐，待执行任务失效。

## Test Plan

新增测试目录：

```text
tests/multiuser/
├── authPolicy.test.ts
├── userManagement.test.ts
├── credentialVault.test.ts
├── futuStepUp.test.ts
├── futuLeakageMatrix.test.ts
├── longbridgeContextRegistry.test.ts
├── longbridgeTenantRoutes.test.ts
├── longbridgeTenantPersistence.test.ts
├── longbridgeTenantJobs.integration.test.ts
└── tenantOrderOwnership.test.ts
```

验证：

1. 单元测试：

   * 角色、首次改密、禁用、密码哈希。

   * AES-GCM 加解密、错误密钥、认证标签篡改。

   * Futu 二次密码限流、TTL、滑动续期、浏览器隔离。

   * Longbridge 上下文按 binding 隔离且不污染 `process.env`。
2. PostgreSQL 集成测试：

   * 租户行级过滤。

   * job 认领、重试、账户归属复核。

   * 唯一活动绑定和幂等确认。
3. API 测试：

   * 完整泄漏矩阵。

   * member 不得回落到 owner 的旧路由。
4. 前端浏览器测试：

   * owner/member 两个独立浏览器上下文。

   * Futu 解锁仅作用于 owner 当前浏览器。

   * Longbridge 未绑定、验证失败、绑定成功、失效重连。

   * 401 返回登录页，403/423/428 显示全中文状态。
5. 回归：

   * 现有测试全部通过。

   * ESLint、定向 TypeScript、Vite build、Python/Node 子进程语法检查通过。

   * 本地未启用 `MULTIUSER_ENABLED` 时原应用行为不变。

## Rollout Plan

### 阶段 0：数据库与暗开关

* 应用 `multiuser_schema.sql`。

* 配置：

  * `MULTIUSER_ENABLED=false`

  * `MULTIUSER_OWNER_USERNAME=<当前账号>`

  * `MULTIUSER_CREDENTIAL_MASTER_KEY=<Secret>`

* 运行 owner 映射预检和 schema 测试。

### 阶段 1：身份与 Futu 门禁

* 先发布 Worker，再发布 Web。

* 开启多用户身份，但暂不开放普通用户 Longbridge 交易。

* owner 设置 Futu 二次密码。

* 完成两个浏览器的 Futu 403/423/解锁/超时测试。

* 此阶段开始后，Futu 门禁必须 fail closed，数据库故障时返回 503，禁止回退裸数据。

### 阶段 2：Longbridge 只读绑定

* owner 继续使用现有环境变量账户。

* 创建测试 member，由本人绑定测试凭据。

* 验证资产、持仓、订单和历史隔离。

* 检查日志、任务表和错误响应无密钥。

### 阶段 3：逐用户影子模式

* 开启 member 租户策略引擎，仅生成建议和待确认预览，不提交。

* 验证 member 与 owner 的市场时段策略一致：覆盖港股早市/午市/午休/收盘，以及美股盘前/盘中/盘后/夜盘、周末和节假日。

* 至少完成一个完整交易日或约定样本量的账户上下文、策略、风控和订单归属核对。

* owner 不能绕过逐户门禁。

### 阶段 4：逐户真实交易

* 每个用户单独记录 `shadow_verified_at` 和 `live_trading_enabled`。

* 先人工确认订单，再考虑该用户自己的自动提交/撤单开关。

* 发布后验证 Worker leader、租户任务、账户归属和券商回执。

### 回滚

* 多用户模块异常时先关闭所有 member 实盘门禁并停止租户调度。

* 保留 Futu 服务端门禁，禁止通过镜像回滚恢复到可能泄漏 Futu 数据的旧版本。

* owner 原 Longbridge 和 Futu 引擎保持现有路径，可在新安全门禁下继续使用。

* 数据库新增 schema 不删除，回滚只停止新写入，便于恢复和审计。

## Acceptance Criteria

* 不同浏览器使用不同账号登录，Cookie、角色、Longbridge 绑定和数据完全独立。

* member 无论通过页面、直接 API、篡改 ID 或读取 Worker 状态，都拿不到任何 Futu 账户数据。

* owner 每次新登录默认看不到 Futu 数据；二次验证只解锁当前浏览器，10 分钟无操作自动锁定。

* 每个用户只能操作自己的 Longbridge 账户；账户、持仓、订单、策略、历史、监管和门禁均带租户键。

* owner 能创建、禁用、重置用户，但不能查看其他用户 Longbridge 密钥或业务数据。

* 现有 Futu/Longbridge 核心目录和页面/hooks 无修改，只有三个入口文件有最小挂载改动。

* 所有新增用户真实交易默认关闭，并严格执行先影子、后逐户开启。

* owner 与 member 使用相同市场时段门禁；非交易时段和节假日不发送 LLM 请求，夜盘开关及订单时段映射保持一致。

* admin 与 member Longbridge 的 Banner、模型评估和提交前复核均使用同一真实交易日历；Futu 市场状态必须经过交易日历校正，完整覆盖当前 20 个股票池标的。

* 云端 admin 与 member 的 Longbridge 订单子进程使用同一 HeySocks 代理环境；缺少代理时发布失败，运行时订单操作失败关闭。

* owner 可独立批准或撤销每个 member 的真实提交门禁；成员开启自动下单后，新待确认订单能够自动进入租户提交任务，并继续接受归属、门禁和交易日历复核。
