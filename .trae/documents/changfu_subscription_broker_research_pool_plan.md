# 长富付费套餐、券商槽位与标的池实施计划

## 一、Summary

本计划把当前“静态套餐页 + 单一用户研究池 + 手工权益快照”升级为可付费、可续费、可审计的订阅系统，并将标的池按用户和券商 Provider 隔离。

首版固定三档套餐：

| 套餐 | 券商槽位 | 每个已绑定券商的池容量 | 每池每月替换额度 |
| --- | ---: | ---: | ---: |
| 轻量版 | 1 | 5 | 1 |
| 高级版 | 2 | 15 | 15 |
| 旗舰版 | 5 | 业务不限量 | 不限 |

价格使用人民币分存储：

| 套餐 | 月付 | 季付 | 年付 |
| --- | ---: | ---: | ---: |
| 轻量版 | ¥29 | ¥79 | ¥299 |
| 高级版 | ¥99 | ¥269 | ¥999 |
| 旗舰版 | ¥299 | ¥799 | ¥2999 |

套餐绑定的是券商 Provider，而不是具体账户。购买时至少选择一个 Provider，未使用槽位可后补；同一用户不能重复绑定同一 Provider。每个 Provider 拥有独立池和版本，Futu、Longbridge 的代码不得混存。架构保留未来增加券商 Provider 的能力，也允许 A 股入口下接多个券商。

标的池支持正股、ETF、Call 和 Put。每份期权合约独立占一个名额。期权首期只参与研究、对话和 SELL PUT 等只读能力，不进入量化交易、候选池或下单链路。

## 二、Current State Analysis

### 2.1 数据库

现有 `migrations/002_quant_trading_control_plane.sql`：

* `research_entitlements` 只有每用户一行的快照，没有套餐目录、订阅周期、订单或支付记录。
* `capacity` 被限制在 0–100，无法表达旗舰版业务不限量。
* `research_pools` 以 `user_id` 为主键，不能区分 Futu 与 Longbridge。
* `research_pool_items` 以 `user_id + symbol` 为主键，只允许 `US/HK + STOCK/ETF`。
* `replacement_limit/replacement_used/renews_at` 无不可变事件记录，不能可靠审计月度替换额度。

本地 PostgreSQL 只读检查结果为 2 个用户、1 个券商连接、0 个研究权益、0 个池标的，因此本机不存在需要迁移归属的旧池数据。迁移仍需保留旧表，避免其他环境中未知数据被破坏。

### 2.2 Gateway 与 Worker

* Gateway 已有研究权益、池查询和增删改接口，但请求没有 Provider，容量按全局池计算。
* Worker 只检查用户级权益和用户级池版本，无法验证订阅槽位和 Provider 池。
* `BrokerProvider`、市场和品种仍有 Futu/Longbridge、US/HK、STOCK/ETF 的硬编码。
* 所有写接口已有 Idempotency-Key 基础设施，可复用于订阅、支付和池变更。

### 2.3 桌面客户端

* `SubscriptionWorkspace.swift` 只显示静态套餐卡，价格与支付按钮均为占位。
* 研究页的“管理标的池”按钮被禁用。
* `AppState` 只保存单个 `serverResearchPool`，没有 Provider 分区和启动缓存。
* Futu/Longbridge Host 只支持 `probe`、`snapshot`，没有证券搜索或期权链命令。
* Futu C++ SDK具备证券基础信息和期权链接口；Longbridge CLI 具备精确 `static` 查询以及 `option chain`。

## 三、已确认产品与账务规则

### 3.1 周期与有效期

* 支持按月、按季、按年，分别为 1、3、12 个日历月。
* 首次支付成功后立即生效，记录 `purchasedAt`、`startsAt`、`currentPeriodStart`、`expiresAt`。
* 首版只支持主动续费，不建立代扣协议。
* 有效期内续费从当前 `expiresAt` 顺延；已过期续费从支付成功时间重新开始。
* 到期或续费失败后，券商绑定和标的池全部保留但冻结；研究、对话、影子量化均不得使用。续费后恢复符合当前套餐的绑定和池。

### 3.2 升降级

* 升级支付成功后立即生效。
* 升级采用剩余价值抵扣：按旧订单实际支付金额和剩余秒数向下取整到分，抵扣新套餐完整周期价格；新周期从升级支付成功时重新开始。
* 抵扣报价有效期 15 分钟，订单保存原价、抵扣额、实付额和计算输入。
* 降级及周期变更在当前到期后生效。
* 降级导致槽位减少时，用户必须在提交变更时明确选择保留哪些 Provider；未选择不得创建变更。
* 超出新套餐容量的池项目不删除，按加入时间保留最早的容量内项目为可用，其余标记为冻结；客户端可在生效前调整。

### 3.3 券商槽位

* 槽位绑定 Provider，例如 `FUTU`、`LONGBRIDGE`，而不是 `brokerConnectionId`。
* 购买时至少绑定一个 Provider，可少于槽位上限；空槽首次绑定不受换绑时间限制。
* Provider 一旦绑定，`nextRebindAt` 为绑定时间后一个日历月。
* 到达 `nextRebindAt` 后可随时换绑；成功换绑后重新锁定一个日历月。
* 包季、包年也按月度周年点开放换绑，不必等到整个订阅到期。
* 换绑后原 Provider 池保留但冻结；以后重新绑定该 Provider 时恢复。

### 3.4 标的与替换

* 每个 Provider 池独立计算容量与替换额度。
* 首次向空余容量加入标的不消耗替换额度。
* 每次移除一个已存在标的立即写替换事件并消耗一次额度，无法通过“先删后加”绕过。
* 替换额度按订阅月度周年窗口重置；季度和年度订阅仍按月切分窗口。
* 轻量每池每月 1 次，高级每池每月 15 次，旗舰不限。
* 期权合约按 Provider 原始合约代码唯一，每份到期日、行权价、Call/Put 组合独立占一个名额。
* 旗舰版数据库容量使用 `NULL` 表示业务不限量；默认配置 10,000 条/Provider 的非展示型防滥用保护阈值，可由运维调整。
* API 固定分页，每页最多 100 条；`/全部` 和量化扫描按 100 条拆批，不能构造无限上下文。

## 四、Proposed Changes

### 4.1 Migration 003

新增 `changfu-backend/migrations/003_subscriptions_provider_pools.sql`，并加入 `scripts/run-local.sh` 的顺序迁移列表。

新增表：

1. `changfu.broker_provider_catalog`
   * `provider_id`、展示名、状态。
   * `supported_markets`、`supported_instrument_types` 使用受控数组。
   * 首批写入 FUTU、LONGBRIDGE；以后新增券商不修改用户池表结构。

2. `changfu.subscription_plan_versions`
   * `plan_version_id`、`plan_code`、`version`、展示名、状态、生效时间。
   * `broker_slot_limit`。
   * `pool_capacity_per_provider`，旗舰为 `NULL`。
   * `monthly_replacement_limit`，旗舰为 `NULL`。
   * `features` 只保存非敏感结构化展示数据。
   * 同一 `plan_code + version` 不可原地修改。

3. `changfu.subscription_prices`
   * `plan_version_id + billing_period` 唯一。
   * `billing_period` 为 `MONTHLY/QUARTERLY/YEARLY`，`duration_months` 为 1/3/12。
   * `currency = CNY`，`amount_minor` 分别写入已确认的九个价格。

4. `changfu.user_subscriptions`
   * `subscription_id`、`user_id`、当前 `plan_version_id`、周期、状态和乐观锁版本。
   * `purchased_at`、`starts_at`、`current_period_start`、`expires_at`。
   * 待生效降级/周期变更引用及生效时间。
   * 每个用户最多一个 ACTIVE/FROZEN 当前订阅。

5. `changfu.subscription_orders`
   * NEW、RENEW、UPGRADE 三类订单。
   * 套餐和价格版本快照、周期、币种、原价、抵扣、应付金额。
   * CREATED/PAYING/PAID/FAILED/CLOSED/REFUNDED 状态。
   * 业务订单号、渠道、渠道订单号/交易号、报价过期时间和各阶段时间。
   * 用户和 Idempotency-Key 唯一；渠道交易号唯一。

6. `changfu.subscription_order_provider_selections`
   * 保存下单时选择的 Provider 和槽位序号，不把选择藏在 JSON 中。

7. `changfu.payment_attempts`、`changfu.payment_webhook_events`
   * 保存支付请求/结果的脱敏元数据、验签结果、渠道事件 ID、重试次数。
   * 原始回调正文、密钥、证书和付款账号不得持久化。
   * 渠道事件 ID 与交易号双重唯一，确保重复回调只生效一次。

8. `changfu.subscription_events`
   * PURCHASED、RENEWED、UPGRADED、CHANGE_SCHEDULED、DOWNGRADED、EXPIRED、RESTORED。
   * 保存前后套餐版本、订单、时间和非敏感原因，作为权益审计来源。

9. `changfu.subscription_broker_slots`
   * `user_id + slot_ordinal` 唯一，保存当前 Provider、ACTIVE/FROZEN/EMPTY、`bound_at`、`next_rebind_at`。
   * 活跃槽位内 `user_id + provider_id` 唯一。

10. `changfu.subscription_broker_binding_history`
    * 保存每次首次绑定、换绑、冻结和恢复，不覆盖历史。

11. `changfu.provider_research_pools`
    * 主键 `user_id + provider_id`，独立 `version`、状态和更新时间。

12. `changfu.provider_research_pool_items`
    * UUID 主键；`user_id + provider_id + provider_symbol` 活跃唯一。
    * `canonical_symbol` 仅用于展示/跨服务引用，不作为跨券商去重依据。
    * 市场支持 US/HK/CN/SG。
    * 品种支持 STOCK/ETF/OPTION。
    * 期权字段：`option_type`、`underlying_symbol`、`expiry_date`、`strike_price`、`currency`、`contract_multiplier`。
    * 保存 `display_name`、`status`、`added_at`、`removed_at`；删除采用软删除。

13. `changfu.research_pool_mutation_events`
    * ADDED/REMOVED/RESTORED 事件。
    * REMOVED 事件用于按月度周年窗口统计替换额度。

兼容策略：

* 保留 `research_entitlements`、`research_pools`、`research_pool_items` 为 002 兼容表，不再作为新链路权威来源。
* migration 003 启动前检查旧池是否有数据；本机为 0。其他环境若存在非空旧池则失败关闭并要求显式指定 Provider，禁止自动复制到多个券商。
* `broker_connections.broker` 改为引用 Provider 目录或由服务端目录校验，移除固定二值 CHECK，为未来券商扩展留入口。

### 4.2 订阅领域与 Repository

新增：

* `changfu-backend/packages/subscriptions/src/catalog.ts`
* `changfu-backend/packages/subscriptions/src/subscriptionService.ts`
* `changfu-backend/packages/subscriptions/src/billingClock.ts`
* `changfu-backend/packages/subscriptions/src/upgradeCredit.ts`
* `changfu-backend/packages/persistence/src/postgresSubscriptionRepository.ts`
* `changfu-backend/packages/persistence/src/postgresProviderPoolRepository.ts`

实现要求：

* 套餐、价格和 Provider 目录从版本化服务端文件加载并在启动时哈希校验、写入数据库。
* 所有购买、续费、升级、降级、换绑、加标的和移除操作使用数据库事务、行锁和乐观版本。
* 权益判断统一使用 `status + starts_at <= now < expires_at`，不能只信任状态字段。
* 读取到已过期订阅时立即返回冻结权益；后台清理任务只负责物化状态，不影响正确性。
* `effectiveEntitlement(userId, providerId)` 同时验证有效订阅、槽位状态和 Provider 绑定。
* Worker 改为调用统一权益解析器，删除对旧 `research_entitlements` 的直接查询。
* 降级冻结、换绑冻结和到期冻结只改变可用性，不删除池或项目。

### 4.3 支付状态机与渠道适配

新增：

* `changfu-backend/packages/payments/src/paymentProvider.ts`
* `changfu-backend/packages/payments/src/paymentService.ts`
* `changfu-backend/packages/payments/src/providers/wechat.ts`
* `changfu-backend/packages/payments/src/providers/alipay.ts`
* `changfu-backend/packages/payments/src/providers/douyin.ts`
* `changfu-backend/apps/gateway/src/routes/subscriptions.ts`
* `changfu-backend/apps/gateway/src/routes/paymentWebhooks.ts`

统一 `PaymentProvider`：

* `createPayment(order)` 返回短期支付 URL/二维码载荷和过期时间。
* `queryPayment(providerOrderId)` 用于客户端轮询异常后的服务端补偿。
* `verifyWebhook(rawBody, headers)` 必须先验签再解析业务字段。
* `closePayment(providerOrderId)` 关闭超时或取消订单。

安全要求：

* 微信、支付宝、抖音使用同一内部订单状态机，渠道差异封装在 adapter 内。
* Webhook 在 bearer 认证之前路由，但必须验证渠道签名、时间窗、防重放和商户号。
* 支付成功只能由验签后的服务端回调触发；客户端返回页和轮询结果不能直接开通权益。
* 商户私钥、API v3 Key、证书等只来自服务端 Secret/环境配置，不进入数据库、日志、桌面端或错误正文。
* 未配置凭据的渠道在套餐目录返回 `available=false`，不能创建订单。
* 支付成功事务内锁定订单和用户订阅，写事件、更新权益和槽位；重复回调返回成功但不重复延长。

### 4.4 Gateway API 与契约

修改 `changfu-contracts/openapi/changfu-v1.yaml`，新增 Schema：

* `subscription-catalog.schema.json`
* `user-subscription.schema.json`
* `subscription-order.schema.json`
* `provider-research-pool.schema.json`
* `instrument-search.schema.json`

新增接口：

* `GET /v1/subscription/catalog`
* `GET /v1/subscription/current`
* `POST /v1/subscription/orders`
* `GET /v1/subscription/orders/{orderId}`
* `POST /v1/subscription/orders/{orderId}/payment`
* `POST /v1/subscription/changes`
* `PUT /v1/subscription/broker-slots/{slotId}`
* `POST /internal/v1/payments/{channel}/webhook`
* `GET /v1/research/pools`
* `GET /v1/research/pools/{providerId}?cursor=&limit=`
* `POST /v1/research/pools/{providerId}/items`
* `DELETE /v1/research/pools/{providerId}/items/{itemId}`

池写入请求必须包含从 Host 返回的完整规范化证券信息，Gateway 重新验证：

* Provider 已绑定且槽位有效。
* 套餐有效、容量和防滥用阈值未超限。
* 市场/品种属于 Provider 能力目录。
* 股票/ETF 不得携带期权字段；期权必须完整携带底层、到期日、行权价、Call/Put 和乘数。
* Provider 原始代码格式合法且未重复。

旧 `/v1/research/pool*` 在一个兼容版本内返回明确弃用信息或映射当前 UI Provider；新桌面全部切换后删除，不能继续维护双写逻辑。

### 4.5 BrokerHost 搜索与期权链

新增共享领域模型：

* `BrokerInstrumentSearchRequest/Response`
* `BrokerInstrument`
* `BrokerOptionExpiry`
* `BrokerOptionContract`
* `BrokerCapability`

修改：

* `changfu-desktop/macos/FutuCppBridge/include/ChangFuFutuBridge.h`
* `changfu-desktop/macos/FutuCppBridge/ChangFuFutuBridge.mm`
* `changfu-desktop/macos/NativeBroker/FutuNativeBroker.swift`
* `changfu-desktop/macos/BrokerHost/main.swift`
* `changfu-desktop/macos/LongbridgeHost/main.swift`
* `changfu-desktop/macos/Infrastructure/FutuBrokerClient.swift`
* `changfu-desktop/macos/Infrastructure/LongbridgeBrokerClient.swift`

Host 白名单增加：

* `capabilities`
* `search-instruments`
* `option-expiries`
* `option-chain`

数据来源：

* Futu：使用 OpenD `GetStockBasicInfo` 做代码/名称过滤，使用 `GetOptionChain` 获取期权。
* Longbridge：股票/ETF 使用精确 `<CODE>.<MARKET>` 的 `static` 查询；期权使用 `option chain <underlying>` 和指定日期二阶段查询。
* Longbridge CLI 没有全市场模糊搜索，客户端不得伪装成支持名称模糊搜索；UI 对该 Provider 明确采用代码精确查询。
* 无法从券商返回中确认品种类型或期权关键字段时，结果标记不可添加，不允许用户手工伪造类型。
* Host 继续使用固定命令和 stdin JSON，不接受 UI 直接拼接任意 CLI 参数。

### 4.6 桌面套餐与标的池 UI

修改：

* `changfu-desktop/macos/Domain/ResearchModels.swift`
* `changfu-desktop/macos/Domain/TradingControlModels.swift`
* `changfu-desktop/macos/Infrastructure/BackendClient.swift`
* `changfu-desktop/macos/App/AppState.swift`
* `changfu-desktop/macos/App/SubscriptionWorkspace.swift`
* `changfu-desktop/macos/App/FutuWorkspaces.swift`
* `changfu-desktop/macos/App/RootView.swift`

套餐页：

* 三张等高套餐面板展示月/季/年分段选择、券商槽位数、每池容量和每月替换次数。
* 当前套餐显示购买时间、起始时间、到期时间、剩余天数、当前绑定和下次可换绑时间。
* 购买流程使用 Sheet：套餐与周期 → 选择至少一个 Provider → 支付渠道 → 订单状态。
* 支付二维码/外部支付链接来自服务端；客户端轮询订单，只在 PAID 后刷新权益。
* 升级显示原价、剩余价值抵扣、应付金额和新到期日。
* 降级要求用户明确选择保留 Provider，并展示将被冻结的池和超额项目。

研究页：

* 标的池按已绑定 Provider 使用顶部 Tabs/segmented control 分区；禁止合并 Futu 与 Longbridge 代码。
* 每个 Provider 显示独立的已用量、容量、替换已用/额度、池版本和冻结原因。
* “管理标的池”打开管理面板，支持代码搜索、股票/ETF筛选以及“底层 → 到期日 → 行权价 → Call/Put”期权选择。
* 搜索结果展示 Provider、原始代码、名称、市场、品种；期权额外显示底层、到期日、行权价、方向和乘数。
* 删除前展示本次将消耗的替换额度并二次确认。
* 到期、Provider 未绑定、额度耗尽、Host 未连接或证券类型不确定时，按钮禁用并显示明确原因。
* `/全部` 读取当前选定 Provider 池；超过 100 时自动按稳定游标拆批，UI 显示批次数和进度。

### 4.7 启动缓存

新增 `ResearchPoolCache`，存放在 macOS Application Support：

* 缓存键为用户 ID 哈希 + Provider，不使用用户名、券商账号或凭据。
* 缓存套餐摘要、Provider 槽位、分页池项目、poolVersion、entitlementVersion、fetchedAt。
* 文件权限 0600，原子写入；退出登录立即清除当前用户缓存。
* 启动先展示缓存并标记“同步中/离线缓存”，随后并发拉取订阅与各 Provider 池。
* Gateway 使用 `ETag = entitlementVersion + provider pool versions`，客户端发 `If-None-Match`。
* 缓存永远不能授权研究、影子量化或写操作；只有本次在线响应验证 ACTIVE 后才开放能力。
* 搜索结果仅内存缓存 5 分钟，不持久化完整证券目录。

### 4.8 Worker 与量化边界

修改 `tradingDecisionAuthority.ts`：

* 按 `userId + providerId` 查询有效订阅、活跃槽位和对应池版本。
* 正股/ETF继续允许进入现有影子交易链路。
* OPTION 可以进入 CHAT/REPORT 与研究技能上下文，但对 SINGLE_DECISION、PORTFOLIO_REVIEW、MANAGED_ORDER_REVIEW 返回 `INSTRUMENT_NOT_TRADABLE_IN_PHASE_2`。
* 旗舰 `/全部` 由桌面按 100 条批次生成独立 requestId；Worker 仍保持单请求最多 100，不能因套餐升级放宽上下文安全上限。

## 五、失败模式与边界

* 支付回调成功但客户端离线：服务端权益照常生效，客户端下次启动拉取。
* 支付回调重复/乱序：按渠道事件 ID、交易号和订单行锁幂等。
* 订单金额或套餐版本不匹配：不生效，写安全审计并进入人工处理。
* 订阅恰在模型运行中到期：Worker 调用模型前重新验证；到期即拒绝。已有结果不产生新交易权限。
* 换绑时旧 Provider 有池：池冻结但不删除；新 Provider 使用自己的历史池或新空池。
* 降级超槽/超容量：按用户明确保留的 Provider 生效；超额项目冻结，不自动删除。
* Provider Host 无搜索能力或未授权：不能添加未经确认的代码。
* 同一经济标的在 Futu/Longbridge 使用不同代码：分别存储和计数，不做未经验证的自动映射。
* 旗舰超过 10,000 条保护阈值：返回防滥用限制错误，不改变“业务不限量”的套餐字段。

## 六、实施顺序

1. 契约与 migration 003：套餐目录、价格、订阅、订单、支付、槽位、Provider 池和证券模型。
2. 订阅/支付领域状态机、Repository、三渠道 adapter 与 Gateway API。
3. Provider 池 Repository、分页/ETag、替换事件和 Worker 权益切换。
4. Futu/Longbridge Host 搜索、期权链和能力探测。
5. 桌面套餐购买/续费/升级/降级/换绑 UI。
6. 桌面 Provider 标的池管理、启动缓存、分页与 `/全部` 分批。
7. 同步更新 `.trae/documents/changfu_desktop_architecture_plan.md` 和 Gateway/Worker 计划文档。
8. 沙箱支付、数据库并发、Host 实盘只读探测、桌面 UI 和完整构建验收。

## 七、Verification

### 7.1 数据库与领域

* migration 003 首次执行和重复执行均成功；旧表非空时按预检规则失败关闭。
* 三档九个价格、槽位、容量和替换额度与本计划一致。
* 月末、闰年、季度/年度月度周年点、过期、续费、即时升级抵扣和预约降级使用固定时钟测试。
* 并发购买、重复回调、并发加池、并发删除、换绑和降级最多生效一次。
* 轻量 5、高级每池 15、旗舰 NULL 容量及 10,000 保护阈值覆盖。

### 7.2 支付

* 三渠道使用官方签名样例完成验签正反测试。
* 回调正文篡改、过期时间戳、错误商户号、金额/币种不匹配全部拒绝。
* 同一渠道事件和交易号重复提交不重复续期。
* 未配置渠道凭据时目录不可用且无法创建支付。
* 有沙箱商户凭据后分别完成下单、支付、回调、查询和关闭订单端到端；没有凭据时不得宣称渠道联调通过。

### 7.3 标的池与 Host

* Futu 和 Longbridge 同代码分别存储、分别计数、分别缓存。
* US/HK/CN/SG 按 Provider 能力开放，不支持组合明确拒绝。
* 股票、ETF、Call、Put 正确归一化；缺失期权关键字段不得加入。
* 每份期权合约占一个名额，删除消耗替换额度，首次填充不消耗。
* 到期、换绑、降级后池保留且冻结；续费或重新绑定恢复。
* Futu 模糊代码/名称搜索、Longbridge 精确代码查询和两家期权链使用 fixture 与真实只读探针验证。

### 7.4 缓存与 UI

* 冷启动、缓存命中、304、离线、缓存损坏、用户切换和退出清除均有测试。
* 离线缓存只能展示，不能启用研究或写操作。
* 旗舰超过 100 个标的时分页完整、无重复/遗漏，`/全部` 分批且每批不超过 100。
* 1440×900、窄窗口、对话展开/折叠下无溢出；套餐卡等高，Provider 池布局与 Futu/Longbridge 工作台一致。
* 更新 `check-ui-contract.sh`，Swift 桌面测试、完整 Swift build、Backend typecheck/test/build、Schema 检查全部通过。
* 按项目门禁补充覆盖率：Domain 100%，Backend >90%；未实际测量不得声称达标。

## 八、Rollout

* 功能标志：`subscription_v1`、`provider_pool_v2`、`payments_wechat`、`payments_alipay`、`payments_douyin`。
* 先发布 migration 和只读目录，再启用池双版本读取，随后启用购买、池写入和支付回调。
* 支付渠道只有在商户凭据、回调公网地址和沙箱验签通过后逐个开启。
* 监控订单创建/支付成功率、回调验签失败、重复事件、权益生效延迟、池容量冲突、换绑冲突和 Host 搜索失败率。
* 真实下单能力不在本计划范围内；本计划不得改变 Phase 2 的“期权不可交易、ORDER_DRAFT 关闭”门禁。

## 九、2026-09-19 实施状态

已完成：

* migration 003、三档九价目录、订阅/订单/支付/槽位状态机及 Gateway API。
* Provider 独立池、容量与替换额度、稳定游标、ETag/304、到期/换绑冻结及 Worker 权威校验。
* Futu/Longbridge Host 的能力探测、证券搜索、期权到期日与期权链统一模型。
* 桌面真实套餐目录、新购/续费/升级/预约降级、支付状态、槽位换绑和 Provider 池管理界面。
* 按用户哈希命名的 Application Support 原子缓存、`0700/0600` 权限、退出清除及“缓存只读不授权”门禁。
* 当前 Provider 的 `/` 选择与 `/全部` 每批最多 100 条拆分；模型上下文不再使用旧的跨 Provider 单池。

已验证：

* Backend typecheck、build、41 项测试和 PostgreSQL 订阅生命周期集成通过；Node 原生覆盖率统计总行覆盖率为 92.64%。
* 15 个 Schema、OpenAPI/黄金样例检查、UI 契约、Swift 主程序构建和 68 项桌面测试通过。
* `ChangFuDomain` 的 329 个区域、134 个函数、958 行覆盖率均为 100%，Domain 100% 与 Backend >90% 门禁已实测通过。

未完成或不能宣称完成：

* 微信、支付宝、抖音支付缺少正式/沙箱商户凭据，当前只能验证未配置时失败关闭及模拟验签回调状态机。
* 当前机器 Longbridge 未授权，未完成真实 Longbridge 搜索与期权链探针。
* 尚未执行 1440×900 与窄窗口的人工视觉验收。
