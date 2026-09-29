# macOS 真实交易门禁与双券商执行计划

## Summary

在现有长富 macOS + `changfu-backend` 架构上完成 Phase 4 真实交易闭环：

- 后台分别开启 Futu 与 Longbridge 的真实交易硬门禁；该门禁不暴露给普通客户端修改。
- 交易 Tab 增加“交易设置”入口，按当前券商独立显示和保存“自动提交真实订单”开关。
- 自动提交关闭时，模型产生的可执行订单进入待确认队列，用户可在独立确认弹窗中人工提交。
- 自动提交开启时，在服务端授权、短期交易会话、设备租约、本地复核和 BrokerHost 全部通过后自动提交。
- Futu 真实订单只由本机 `ChangFuBrokerHost` 通过 Futu OpenD C++ SDK 执行。
- Longbridge 真实订单只由本机 `ChangFuLongbridgeHost` 通过随 App 打包、基于 Longbridge 开放平台 SDK 的官方 CLI 执行。
- 订单创建、claim、提交开始、券商回执、状态变化和撤单结果全部持久化到 AIDAP PostgreSQL。
- 同一标的的新信号必须与仍有效的旧信号、待确认意图、已提交挂单和部分成交状态做冲突裁决；
  新信号不得绕过旧订单直接叠加或反向。
- 信号过期、订单不可成交或最新信号推翻旧信号时，自动撤销系统托管订单的未成交剩余数量。
- 正股与 ETF 开放 `SELL_SHORT`/`BUY_BACK`，但必须通过融券、保证金和强平风险门禁。
- 保持 Futu/Longbridge 数据、门禁、任务、订单和缓存隔离。
- 实施完成后，两个券商分别提交一笔 `AAPL.US`、1 股、DAY/RTH 的低价买入限价单，取得订单号后立即撤单。

本次不开放期权真实交易，不新增改单 UI，不允许模型文本直接调用券商，不把券商凭据或 Futu 交易密码发送到云端。

## Current State Analysis

### 已具备

- `changfu-backend` 已有：
  - ContextEnvelope 2.0、设备签名校验、交易目录和配置。
  - `SignedOrderIntent` 结构及 Ed25519 签名/验签基础。
  - `pending_orders`、`order_executions`、`order_events` 表。
  - 90 秒 `trading_sessions` 和 `trading_leases`。
  - pending order claim 和 submission 状态机的部分 repository 能力。
- macOS 已有：
  - Futu/Longbridge 独立账户、快照、交易配置和影子运行状态。
  - `SignedOrderIntent` 客户端验签器。
  - 交易 Tab、策略中心订单只读展示。
  - Futu OpenD C++ Bridge 和独立 BrokerHost。
  - Longbridge CLI、Legacy API 凭据 Keychain 和独立 LongbridgeHost。
- 旧 Web 实现已有可复用业务语义：
  - Futu `api/live/futuLiveOrderService.ts`。
  - Longbridge `api/longbridge/longbridgeLiveOrderService.ts` 与
    `longbridgeSdkOrderChild.mjs`。
  - 开仓购买力、持仓反向穿透、港股每手股数、融资风险、订单状态映射、
    remark 查单和自动提交规则。

### 当前缺口

- `changfu-backend` Worker 明确拒绝 `ORDER_DRAFT`，模型结果只保存信号/候选。
- `TradingOutcomeRepository` 不创建签名 pending order。
- Gateway 没有执行设置、pending order 列表、提交开始、提交结果、拒绝和撤单回传 API。
- 新后端没有 Futu/Longbridge 分券商真实交易硬门禁，也没有用户级自动提交设置。
- Futu C++ Bridge 只有只读交易查询，没有 `PlaceOrder`/`ModifyOrder`。
- LongbridgeHost 只开放只读命令。
- macOS 没有交易租约/自动会话心跳、待确认订单、确认弹窗和真实执行协调器。
- 架构文档仍将 Longbridge 写交易和自动提交列为禁止项，必须随实现升级。

### 工作区保护

当前工作区已有尚未提交的内部 DMG 变更：

- `.trae/documents/changfu_desktop_architecture_plan.md`
- `changfu-desktop/macos/Package.swift`
- `changfu-desktop/macos/Packaging/Info.plist`
- `changfu-desktop/macos/README.md`
- `changfu-desktop/macos/docs/`
- `changfu-desktop/macos/scripts/`

实施必须保留这些修改；对架构文档和发布脚本只做增量合并，不回退现有内容。

## Product Decisions

1. **真实交易硬门禁**
   - 按 Provider 分为 `FUTU` 和 `LONGBRIDGE` 两个后台门禁。
   - 由 Gateway/Worker 部署环境控制：
     - `CHANGFU_FUTU_LIVE_TRADING_ENABLED=true`
     - `CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED=true`
   - 普通 App 只能读取，不能修改。
   - Gateway 和 Worker 任一侧未开启、配置不一致或券商连接不是 `REAL` 时 fail closed。

2. **自动提交设置**
   - App 只提供“自动提交真实订单”开关。
   - 按 `user_id + provider` 持久化，Futu 与 Longbridge 互不影响。
   - 默认值为 `false`；已有值在升级、重启、重新登录和云/本地切换中保持，不得因缺省解码被覆盖。
   - 关闭：订单进入人工确认队列，仍允许人工确认后真实提交。
   - 开启：必须先显示高风险确认弹窗；成功建立 90 秒自动交易会话后才生效。
   - 退出登录、账号/券商切换、设备租约丢失、休眠、断网、BrokerHost 断连或交易会话续租失败时立即停止自动提交。服务端偏好保留，但本次运行必须重新取得有效会话后才恢复执行。

3. **Futu 解锁**
   - 长富不接收、不保存 Futu 交易密码。
   - 用户必须在 Futu OpenD 外部完成交易解锁。
   - BrokerHost 提交前若 OpenD 返回锁定错误，显示明确中文原因并保持订单未提交/失败状态，禁止自动重试。

4. **Longbridge 执行层**
   - 复用 App 已打包的 Longbridge 官方 CLI 写命令；该 CLI 使用 Longbridge 开放平台 SDK。
   - 调用 `order buy|sell ... --yes --format json` 和
     `order cancel ... --yes --format json`。
   - 凭据继续只通过 Host stdin 注入子进程环境，不进入命令行、日志、数据库或崩溃信息。

5. **真实订单范围**
   - 仅正股/ETF。
   - 首期只支持 `MARKETABLE_LIMIT`，映射为券商限价单；不开放普通市价自动开仓。
   - 支持 `BUY`、`SELL_TO_CLOSE`、`SELL_SHORT`，并根据当前持仓确定
     `OPEN_LONG/ADD_LONG/COVER_SHORT/REDUCE_LONG/OPEN_SHORT/ADD_SHORT`。
   - 港股必须验证 lot size；美股数量必须为正整数。
   - 订单 intent 最长有效 60 秒；过期必须重新评估，不允许客户端改价续用。

6. **信号冲突与订单所有权**
   - 冲突域固定为 `user_id + broker_connection_id + normalized_symbol`，Futu 与
     Longbridge、不同账户之间不得互相撤单。
   - 只管理带有效 `cf:<intentId>` remark 且能回溯到本系统签名 intent 的系统托管订单。
   - 用户在券商 App/OpenD 手工创建或第三方创建的订单只作为冲突阻断条件，长富不得自动撤销。
   - 同标的任意时刻最多允许一个未终态系统 intent/order；数据库事务与唯一约束共同保证。
   - 旧单撤销到终态前，禁止创建新单、反向单或“撤后立即重下”。
   - 部分成交只撤销剩余数量；已成交数量不可逆，撤单后必须重拉真实持仓并重新运行模型。
   - 自动撤单属于风险缩减安全动作，不受“自动提交真实订单”开关关闭影响。
   - 自动撤单覆盖所有系统托管订单，包括自动提交订单和用户人工确认后提交的系统订单。

7. **正股卖空**
   - `SELL_SHORT` 是明确动作，不得把普通 `SELL` 猜测为卖空。
   - Futu 业务层保留 `SELL_SHORT`/`COVER_SHORT`；当前 OpenD SDK 明确要求客户端
     下单只发送 `TrdSide_Sell`/`TrdSide_Buy`，`SellShort`/`BuyBack` 仅作为券商
     回执方向解析，禁止向下单协议发送服务端回执枚举。
   - Longbridge 映射官方 CLI `order sell`/`order buy`，但必须由
     `positionEffect=OPEN_SHORT|ADD_SHORT|COVER_SHORT` 明确区分语义。
   - 卖空前必须确认 REAL 保证金账户、标的可卖空/券源可用、最大可卖空数量、初始/维持保证金、
     margin call 状态、账户风险声明和市场限制；任一能力不可验证即 HOLD。
   - 禁止一步穿透零仓位反向：多头转空必须先 `SELL_TO_CLOSE` 到零，空头转多必须先
     `BUY_BACK` 到零，之后由新一轮信号决定是否反向开仓。

## Same-Symbol Conflict Operation List

以下规则按最新有效信号处理。`撤销`均指撤销未成交剩余数量，不回滚已成交部分。

### A. 按旧订单生命周期处理

| 旧状态 | 新信号到达后的动作 |
|---|---|
| 仅有信号/候选，尚未生成 intent | 将旧信号标记 `SUPERSEDED`；只允许最新信号继续裁决 |
| `PENDING_CONFIRMATION`，尚未提交券商 | 将旧 intent 标记 `SUPERSEDED`，不调用券商；再处理最新信号 |
| `CLAIMED`，尚未开始提交 | 使 claim 失效并标记 `SUPERSEDED`；再处理最新信号 |
| `SUBMITTING`，提交结果未知 | 禁止新单；先按 remark、字段和时间窗查单，确认不存在或取得唯一订单后再继续 |
| `SUBMITTED/TRACKING`，未成交 | 若新信号冲突或旧信号过期，发起幂等撤单；撤单终态前禁止新单 |
| `PARTIALLY_FILLED` | 撤销剩余数量；保留已成交事实；重拉持仓后由新一轮信号决定下一步 |
| `CANCEL_REQUESTED/CANCEL_PENDING` | 不重复撤单、不创建新单；持续对账直到终态 |
| `UNKNOWN` | 冻结该标的新执行；优先查券商并告警，禁止用重下作为恢复手段 |
| `FILLED/CANCELLED/REJECTED/EXPIRED` | 已终态，不构成旧单冲突；仍须使用最新持仓和购买力重新决策 |
| 同标的存在非系统订单 | 不自动撤销；阻断新系统订单并提示用户先处理外部订单 |

### B. 按旧订单方向与最新信号处理

| 旧系统订单 | 最新 `HOLD` | 最新 `BUY` | 最新 `SELL_TO_CLOSE` | 最新 `SELL_SHORT` |
|---|---|---|---|---|
| `BUY + OPEN_LONG/ADD_LONG` | 撤销旧单剩余量 | 相同方向不重复下单；原单仍新鲜且参数一致则继续，否则撤销后重新评估 | 撤销旧买单；若有部分成交，撤单终态后只允许按真实多头数量平仓 | 撤销旧买单；若有部分成交必须先平多到零，禁止直接穿透开空 |
| `BUY_BACK/COVER_SHORT` | 撤销旧回补单剩余量 | 相同回补方向不重复下单；参数失效则撤销后重评 | 语义与当前空头冲突；撤销旧单并刷新持仓，不能直接卖出 | 撤销旧回补单；若仍有空头，新一轮才可决定继续/增加空头 |
| `SELL_TO_CLOSE/REDUCE_LONG` | 撤销旧平多单剩余量 | 撤销旧卖单；刷新剩余多头后再决定是否加多 | 相同平多方向不重复下单；参数失效则撤销后重评 | 撤销旧平多单；剩余多头必须先平到零，之后新一轮才可开空 |
| `SELL_SHORT + OPEN_SHORT/ADD_SHORT` | 撤销旧卖空单剩余量 | 撤销旧空单；如已部分成交，BUY 只能先回补到零，禁止直接反向开多 | 与空头持仓语义不符；撤销旧单并刷新持仓 | 相同卖空方向不重复下单；参数失效则撤销后重评 |

补充规则：

- “参数一致”必须同时满足 side、position effect、数量目标、限价、交易时段、risk plan
  和 config version 一致；只要其中之一改变，就不修改旧单，而是撤销后重新评估。
- 新旧同方向但新信号数量更大时，不补差额、不叠单；等待旧单终态后重新计算目标。
- 最新信号是明确 HOLD、因输入过期而降级 HOLD，或风控禁止继续执行时，均撤销系统托管旧单。
- 新信号本身无效、解码失败或无法确认其时间顺序时，不据此反向下单；但旧信号/订单一旦超过
  自身有效期，仍按过期规则撤单。
- 同一批并发信号按服务端 `created_at + signal_id` 确定全序，并用数据库 advisory lock 串行处理。

### C. 自动撤单触发条件

以下任一条件成立即对系统托管订单发出幂等撤单请求：

1. `signal.valid_until` 或 `intent.expires_at` 已过期。
2. 最新有效信号为 HOLD，或与旧单方向/position effect 冲突。
3. `MARKETABLE_LIMIT` 未在 90 秒内全部成交。
4. 普通 `LIMIT` 未在 600 秒内全部成交。
5. 订单已部分成交但剩余数量在对应超时内无新增成交。
6. 最新报价相对签名 intent 的参考价/限价漂移超过 15 bps，旧价格已失效。
7. 买卖盘、最新价或券商订单快照过期，已无法继续证明该订单仍符合签名风险条件。
8. 交易时段结束、标的停牌、订单会话不再匹配，或 Broker 报告订单不再可成交。
9. 账户购买力、现金、持仓可平数量、保证金状态、融资风险或卖空券源发生变化，
   导致剩余订单不再通过硬风控。
10. 用户退出登录、当前设备失去交易租约或 broker connection 被禁用时，优先撤销仍可撤的
    系统托管挂单；App 离线无法执行时记录高优先级待撤任务，重连后先撤单再恢复研究。

撤单处理：

- 撤单请求使用稳定 idempotency key；重复 tick 不重复产生券商撤单。
- 券商受理后每 1 秒查询一次，最多 20 秒；确认 `CANCELLED/PARTIAL_CANCELLED` 才释放冲突锁。
- 20 秒仍未知则标记 `CANCEL_UNCERTAIN`，冻结该标的并告警，不自动重下。
- 券商明确 `FILLED` 时以成交为准，停止撤单并刷新持仓。
- 券商明确不可撤但仍未终态时持续对账，禁止新单。
- 自动撤单后不自动追价或替换；必须等待下一轮独立模型请求生成新信号。

## Proposed Changes

### 1. 更新架构文档

文件：

- `.trae/documents/changfu_desktop_architecture_plan.md`

增量新增 Phase 4 实现章节，并修订“当前边界”：

- 将 Longbridge 写交易从“禁止”升级为受硬门禁保护的本机执行能力。
- 将“首期不提供自动下单开关”更新为本次确定的双层模型：
  后台 Provider 硬门禁 + App Provider 自动提交偏好。
- 固化人工确认、自动会话、交易租约、客户端复核、幂等 remark、超时查单、
  回执落库、休眠/断网熔断和 Futu 外部解锁规则。
- 明确后台绝不连接券商；真实订单仍只在用户设备本机执行。
- 记录真实验收订单策略及回滚方法。

### 2. 数据库迁移与执行设置

新增：

- `changfu-backend/migrations/013_live_trading_execution.sql`
- `changfu-backend/packages/persistence/src/postgresLiveTradingRepository.ts`

迁移内容：

- 新建 `changfu.user_provider_execution_settings`：
  - `user_id`
  - `provider`
  - `auto_submit_enabled`
  - `version`
  - `updated_at`
  - 主键 `(user_id, provider)`
- 为 `candidate_pool_items` 增加经过服务端校验的 `order_draft jsonb`。
- 为 `signals` 增加 `lifecycle_status`、`superseded_at`、`superseded_by_signal_id`
  和 `valid_until`，保留历史但只允许最新有效信号驱动订单。
- 为 `pending_orders` 增加可索引的 `symbol`、`side`、`position_effect`、
  `submission_mode`、`signal_valid_until`、`superseded_by_signal_id` 和
  `cancel_reason_code`。
- 为 `order_executions` 补齐 provider、broker connection、状态、请求时间、
  原始回执摘要和更新时间字段；敏感字段禁止进入 JSON。
- 为 `order_events` 增加 provider/broker connection 查询索引。
- 增加“同一用户 + 连接 + 标的只允许一个未终态系统订单”的部分唯一索引；
  `SUBMITTING/UNKNOWN/CANCEL_PENDING/CANCEL_UNCERTAIN` 均视为未终态。
- 保持现有 `liveTradingEnabled`/`autoSubmitEnabled` 值不被迁移默认覆盖；
  新记录默认 `auto_submit_enabled=false`。

Repository 提供：

- 获取/更新用户 Provider 自动提交设置，使用 expected version 乐观锁。
- 查询当前连接的 pending orders。
- 原子创建签名 pending order。
- `claim -> SUBMITTING -> SUBMITTED/FAILED` 原子状态推进。
- 订单拒绝、过期、撤单请求和最终状态同步。
- 对 `user_id + broker_connection_id + normalized_symbol` 获取 transaction-scoped
  advisory lock，原子完成信号 supersede、冲突判断和撤单任务创建。
- 以 `intent_id` 和 `idempotency_key` 保证最多一次券商提交。

### 3. 后台真实交易 API 与双重门禁

更新：

- `changfu-backend/apps/gateway/src/routes/controlPlane.ts`
- `changfu-backend/apps/gateway/src/server.ts`
- `changfu-backend/packages/domain/src/contracts.ts`
- `changfu-backend/packages/domain/src/orderIntentStateMachine.ts`
- `changfu-backend/packages/persistence/src/postgresOrderIntentRepository.ts`

新增 API：

- `GET /v1/trading/execution-settings?provider=FUTU|LONGBRIDGE`
- `PUT /v1/trading/execution-settings/:provider`
  - 只接收 `autoSubmitEnabled` 和 `expectedVersion`。
  - 返回后台硬门禁、保存后的自动提交状态及阻断原因。
- `GET /v1/trading/order-intent-keys`
  - 返回当前订单签名 key ID 与 Ed25519 公钥，不返回私钥。
- `GET /v1/pending-orders?brokerConnectionId=...`
- `POST /v1/pending-orders/:intentId/claim`
- `POST /v1/pending-orders/:intentId/submissions`
- `PUT /v1/order-executions/:executionId/result`
- `POST /v1/pending-orders/:intentId/reject`
- `POST /v1/pending-orders/:intentId/cancel-request`
- `GET /v1/order-actions?brokerConnectionId=...`
- `POST /v1/order-actions/:actionId/claim`
- `PUT /v1/order-actions/:actionId/result`

`order-actions` 同时承载新信号冲突、过期、不可成交和账户风险变化产生的撤单任务。
撤单任务不要求 `autoSubmitEnabled=true`，但仍要求设备归属、交易租约和本机券商连接匹配。

所有写接口要求 Bearer、设备归属、`Idempotency-Key`、连接归属和 REAL 环境。
每个执行阶段都重新校验：

- Provider 硬门禁已开启。
- 用户套餐有效且该 Provider 槽位 ACTIVE。
- 账号、设备和 broker connection 匹配。
- intent 未过期且签名/版本/状态正确。
- 自动提交时存在有效 `AUTO_EXECUTE` session。
- 人工提交时 intent 为 `MANUAL_CONFIRM`。
- claim token 未过期且未被使用。

### 4. Worker 生成服务端签名订单意图

更新：

- `changfu-backend/apps/decision-worker/src/server.ts`
- `changfu-backend/apps/decision-worker/src/modelResultNormalizer.ts`
- `changfu-backend/apps/decision-worker/src/decisionService.ts`
- `changfu-backend/apps/decision-worker/src/tradingDecisionAuthority.ts`
- `changfu-backend/apps/decision-worker/src/tradingOutcomeRepository.ts`
- `changfu-backend/packages/domain/src/signedOrderIntent.ts`
- `changfu-backend/catalog/trading/catalog.v1.yaml`

新增：

- `changfu-backend/packages/domain/src/liveOrderRiskPolicy.ts`
- `changfu-backend/packages/domain/src/sameSymbolConflictPolicy.ts`

实现：

- 单票模型输出增加 `proposedOrder`，只允许方向、正整数数量、限价、
  交易时段和交易周期等候选字段；模型不得生成 ID、签名、账户或 Provider。
- Normalizer 严格解析并将越权/缺字段/数据缺口结果降级为 HOLD。
- 使用旧 Web 已验证的风控语义重写为无状态领域函数：
  - 买入购买力/现金保护。
  - 平仓数量不超过可平数量。
  - 回补数量不反向开多。
  - 港股 lot size。
  - Longbridge 融资风险等级与 margin call。
  - 同标的未终态订单冲突。
  - 市场时段、报价新鲜度、最大 15 bps 滑点。
- DIRECT 模式在有效非 HOLD 信号后创建 pending order。
- CANDIDATE_POOL 模式把 `order_draft` 随候选保存，只在 portfolio review
  `PROMOTED` 后创建 pending order。
- Worker 使用独立订单签名密钥
  `CHANGFU_ORDER_INTENT_PRIVATE_KEY_PEM`/`CHANGFU_ORDER_INTENT_KEY_ID`；
  不复用访问令牌私钥。
- 自动提交设置关闭时签发 `MANUAL_CONFIRM` intent；开启且存在有效
  trading session 时签发 `AUTO_EXECUTE` intent，否则 fail closed 到人工确认。
- 删除当前无条件拒绝 `ORDER_DRAFT` 的 Phase 2 限制，但保留 CHAT、REPORT、
  数据缺口和不支持标的的禁止规则。
- 每个新信号先进入同标的冲突协调器：
  - 旧候选/待确认 intent 可直接 supersede。
  - 已提交订单只产生撤单 action，不直接创建新 intent。
  - 部分成交后必须等撤单终态并刷新持仓。
  - 撤单状态未知时冻结该标的。
- `SELL_SHORT` 必须输出独立 position effect、失效价、最大损失、保证金与强平风险说明；
  普通 SELL 不得被提升为卖空。

### 5. macOS 后台协议与状态

更新：

- `changfu-desktop/macos/Domain/TradingControlModels.swift`
- `changfu-desktop/macos/Domain/SignedOrderIntent.swift`
- `changfu-desktop/macos/Infrastructure/BackendClient.swift`
- `changfu-desktop/macos/App/AppState.swift`

新增：

- `changfu-desktop/macos/Domain/LiveOrderModels.swift`
- `changfu-desktop/macos/Infrastructure/LiveOrderCoordinator.swift`
- `changfu-desktop/macos/Infrastructure/ManagedOrderSupervisor.swift`

实现：

- 解码执行设置、交易会话、租约、pending order、claim、execution 和事件。
- 分 Provider 保存 UI 状态、pending orders、自动提交偏好和运行时会话。
- App 启动/登录后读取 Futu 与 Longbridge 设置，但只渲染当前 Provider。
- 开启自动提交时：
  1. 高风险确认弹窗。
  2. 验证当前为 REAL 账户、券商连接正常、硬门禁开启。
  3. Futu 验证 OpenD 可交易；Longbridge 验证完整三字段凭据。
  4. 获取交易租约并激活 90 秒自动交易会话。
  5. 每 30 秒续租；任何失败立即停止自动提交。
- 新 pending order 到达后统一走：
  1. 校验服务端签名及所有绑定。
  2. 重拉账户、持仓、报价、未终态订单。
  3. 执行与服务端相同的本地硬风控。
  4. 人工模式显示确认弹窗；自动模式直接进入 claim。
  5. claim、begin submission、本地券商提交、回传执行结果。
  6. 提交超时先按 intent remark + 时间窗 + 字段查单，不直接重试。
- `ManagedOrderSupervisor` 每 5 秒同步系统托管的未终态订单，并优先消费撤单 action：
  - 按信号/intent 有效期、90/600 秒超时、价格漂移、部分成交进度、交易时段和账户风险判断。
  - 撤单执行不受自动提交开关影响。
  - App 重连后先完成待撤/状态未知订单对账，再允许新订单。
  - 对 broker 外部订单只阻断和提示，不发送撤单。
- App 切换券商不影响另一 Provider 的持久偏好，但取消当前不可见 Provider 的
  本地提交任务，避免跨平台错单。

### 6. 交易 Tab UI

更新：

- `changfu-desktop/macos/App/FutuWorkspaces.swift`

UI 设计：

- 交易页右上角新增齿轮图标按钮，打开独立“交易设置”Sheet。
- Sheet 显示当前券商、REAL 账户、后台硬门禁、设备租约、券商可交易状态。
- 唯一可编辑开关为“自动提交真实订单”。
- 开启时弹出二次确认，明确列出：
  - 当前券商和账户。
  - 模型产生订单后无需逐笔确认。
  - 仍受 60 秒 intent、90 秒 session、15 bps 滑点和本地硬风控限制。
- 关闭开关立即停用 session；已有待确认订单不自动提交。
- 顶部状态从固定“影子模式/真实下单关闭”改为真实状态：
  - `实盘人工确认`
  - `实盘自动提交`
  - `真实交易后台关闭`
  - `交易会话已失效`
- 增加待确认订单区域；详情使用独立弹窗，不做行内展开。
- 增加“系统挂单监管”状态：最新信号、原信号、冲突类型、撤单原因、剩余数量和
  `待撤/撤单中/撤单不确定` 状态；不把冲突明细行内展开。
- 人工确认弹窗必须一次展示方向、数量、限价、账户、Provider、有效期、
  预计名义金额、费用、主要风险和确认/拒绝按钮。
- 提交中禁止重复操作；成功后展示券商订单号，失败显示具体门禁或券商原因。

### 7. Futu OpenD 写交易适配

更新：

- `changfu-desktop/macos/FutuCppBridge/include/ChangFuFutuBridge.h`
- `changfu-desktop/macos/FutuCppBridge/ChangFuFutuBridge.mm`
- `changfu-desktop/macos/NativeBroker/FutuNativeBroker.swift`
- `changfu-desktop/macos/BrokerHost/main.swift`
- `changfu-desktop/macos/Infrastructure/FutuBrokerClient.swift`

新增 BrokerHost 命令：

- `trade-readiness`
- `place-order`
- `cancel-order`
- `find-order-by-intent`

要求：

- 使用 `Trd_PlaceOrder` 和 `Trd_ModifyOrder`，环境强制 `REAL`。
- 不实现内部交易密码存储或解锁；OpenD 未解锁时明确失败。
- 根据市场设置 `TrdHeader`，严格匹配账户 ID 和市场授权。
- `SELL_SHORT`/`COVER_SHORT` 必须在长富业务层保持显式语义并完成卖空门禁；向当前
  OpenD SDK 下单时分别发送 `TrdSide_Sell`/`TrdSide_Buy`，查询回执时兼容解析
  `TrdSide_SellShort`/`TrdSide_BuyBack`；普通 `SELL` 只允许 `REDUCE_LONG`。
- 下单前调用最大可交易数量/账户能力查询；无法证明卖空能力时拒绝订单。
- remark 包含稳定的 `cf:<intentId>`，用于超时后查单。
- 返回标准化 order ID、状态、提交/成交数量、均价和错误码。
- cancel 只允许本 intent 对应的未终态订单。

### 8. Longbridge 官方 CLI/SDK 写交易适配

更新：

- `changfu-desktop/macos/LongbridgeHost/main.swift`
- `changfu-desktop/macos/Infrastructure/LongbridgeBrokerClient.swift`

新增 Host 命令：

- `trade-readiness`
- `place-order`
- `cancel-order`
- `find-order-by-intent`

实现：

- `BUY/COVER_SHORT` 映射 `order buy`，`SELL_TO_CLOSE/SELL_SHORT` 映射
  `order sell`。
- Host 必须保留 position effect 并校验：SELL_SHORT 仅在保证金账户、融资风险允许、
  风险声明已确认且券商接受卖空时提交；回补数量不得超过当前空头数量。
- 只允许 `LO` + `day`；按会话映射
  `RTH_ONLY/ANY_TIME/OVERNIGHT`。
- 加 `--yes --format json`，remark 为 `cf:<intentId>`。
- 输入仍通过 stdin；凭据仅注入子进程环境。
- 对 CLI 输出做严格 JSON schema 校验和错误本地化。
- 超时后通过今日订单按 remark、symbol、side、quantity、price 和时间窗查单，
  找到唯一订单才视为已提交。

### 9. 测试

Backend：

- 更新 `changfu-backend/tests/domain.test.ts`：
  签名、过期、Provider/账号/版本/会话绑定及风险规则。
- 更新 `changfu-backend/tests/controlPlane.test.ts`：
  Provider 门禁、自动设置乐观锁、租约、claim、提交结果和拒绝。
- 更新 `changfu-backend/tests/decisionService.test.ts`：
  DIRECT/CANDIDATE_POOL、人工/自动 intent、数据缺口降级。
- 更新 `changfu-backend/tests/migrations.test.ts` 和
  `schemaPrivacy.test.ts`。
- 新增 `changfu-backend/tests/liveTradingExecution.test.ts`：
  并发确认、超时查单、重复回传、跨用户/跨 Provider 拒绝。
- 新增 `changfu-backend/tests/sameSymbolConflictPolicy.test.ts`：
  覆盖四类旧订单 × 四类新信号的完整矩阵、生命周期矩阵、部分成交、撤单不确定、
  外部订单和并发信号全序。
- 新增 `changfu-backend/tests/managedOrderExpiry.test.ts`：
  覆盖信号过期、90/600 秒无成交、无成交进度、价格漂移、休市、停牌、持仓/保证金变化。
- 增加 SELL_SHORT/COVER_SHORT 风控测试：
  无融券能力、保证金预警、风险声明未确认、数量超限、禁止穿透零仓位、Futu/Longbridge 映射。

macOS：

- 扩展 `changfu-desktop/macos/TestRunner/main.swift`：
  - 设置状态按 Provider 隔离并跨刷新保留。
  - 自动开关确认、关闭熔断、会话续租。
  - 签名、上下文和本地风险失败均不调用 Host。
  - Futu/Longbridge payload 映射。
  - 超时查单和最多一次提交。
  - 人工确认与自动提交路径。
  - 新信号 HOLD/同向/反向时对旧 pending、submitted、partial、unknown 订单的处理。
  - Supervisor 在自动提交关闭时仍执行安全撤单。
  - SELL_SHORT 与 BUY_BACK/COVER_SHORT 的 Host payload 和错误本地化。
- 扩展 `scripts/check-ui-contract.sh`：
  - 交易设置使用独立 Sheet。
  - 状态中文化。
  - 待确认订单固定列宽、斑马纹、弹窗详情。
- Host 写接口测试使用 fake SDK/CLI，不允许普通测试触发真实订单。

门禁：

- 领域层行覆盖率保持 100%。
- Backend 覆盖率保持大于 90%。
- `npm run check`、数据库集成测试、Swift 测试、UI contract、Release 构建、
  DMG 自包含和签名检查全部通过。

## Rollout

1. 保留现有未提交 DMG 工作，完成代码和文档增量修改。
2. 本地迁移 PostgreSQL，运行 Gateway/Worker 和客户端。
3. 默认保持两个 Provider 后台硬门禁关闭，完成全部 fake/simulate 验证。
4. 提交并 push 代码。
5. 通过指定部署机 `ECS-0EJj-deploy` 发布 Worker，再发布 Gateway；
   数据库仍使用 AIDAP PostgreSQL `financial`。
6. 在云 Worker/Gateway 同时注入并开启：
   - `CHANGFU_FUTU_LIVE_TRADING_ENABLED=true`
   - `CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED=true`
   - 独立订单签名私钥和 key ID。
7. 验证 `/v1/ready`、执行设置、登录、双 Provider 连接及门禁一致性。
8. 构建并启动最新 macOS App，确认两个 Provider 的自动提交开关默认关闭。

## Controlled Real-Order Verification

真实验收必须在所有自动测试通过后执行，且 App 自动提交开关保持关闭：

1. 分别读取 Futu 和 Longbridge 的 REAL 账户、`AAPL.US` 最新买一价、最小价位、
   购买力、当前持仓和未终态订单。
2. 每个 Provider 构造一笔：
   - 标的：`AAPL.US`
   - 方向：买入
   - 数量：1 股
   - 类型：DAY/RTH 限价单
   - 价格：最新有效买一价的 80%，向下按该券商最小价位取整
3. 完成并确认买入测试撤单终态后，每个 Provider 再构造一笔卖空能力测试：
   - 标的：`AAPL.US`
   - 方向：`SELL_SHORT`
   - 数量：1 股
   - 类型：DAY/RTH 限价单
   - 价格：最新有效卖一价的 120%，向上按该券商最小价位取整
   - Futu 业务语义保持 `SELL + OPEN_SHORT`，按当前 SDK 客户端请求约束发送
     `TrdSide_Sell`，并在回执解析中兼容 `TrdSide_SellShort`；Longbridge 必须携带
     `positionEffect=OPEN_SHORT`
4. 任一前置数据缺失、账户非 REAL、市场映射异常、价格非法、已有同 intent 订单、
   Futu 未在 OpenD 外部解锁或 Longbridge 凭据不完整时跳过该 Provider，禁止降级为市价。
   卖空测试还必须确认保证金账户、卖空风险声明、标的可卖空、券源和最大可卖空数量；
   任一能力无法验证时不得发送卖空订单。
5. 使用唯一 intent/remark 提交；取得订单号后立即按订单号查询并撤单。
6. 再次查询确认状态为已撤销/撤销处理中；若任意买入或卖空订单已意外成交，立即停止
   当前及后续测试并报告
   成交数量、均价和持仓变化，不自动提交反向平仓。
7. 核对 AIDAP 中 pending order、execution、event 与券商订单号一致。

风险说明：即使买入限价为买一价的 80%、卖空限价为卖一价的 120%，真实市场极端波动下
仍存在成交可能。批准本计划即表示同意按上述固定公式对 Futu 和 Longbridge 各发送并撤销
一笔真实买入订单和一笔真实卖空订单。

## Rollback

- 首先把两个 Provider 硬门禁改回 `false`，Gateway/Worker 任一侧关闭即阻断新提交。
- 停用所有 ACTIVE trading session 和 lease。
- App 自动提交设置置为 false；保留历史订单、执行和事件，不删除审计记录。
- 已提交券商订单按订单号查询并撤销；状态未知时不重试下单。
- 数据库迁移只增加兼容字段/表，不做破坏性 down migration。

## Assumptions & Decisions

- `admin` Web 管理账号不参与客户端交易。
- 当前业务用户为 `shockcao`，但所有 API 仍按认证 user ID 隔离实现。
- “每个券商”定义为当前用户下 `FUTU` 与 `LONGBRIDGE` 两个 Provider 设置，
  而不是全系统全用户共享一个自动开关。
- Futu 与 Longbridge 后台硬门禁是部署级 Provider 开关；App 不可修改。
- 自动提交偏好持久化，但每次实际自动提交仍必须有当前设备的有效短租约/交易会话。
- 不在本次实现期权下单、资金划转、改单 UI 或跨设备自动接管。
- Longbridge 使用已随 App 打包的官方 CLI 交易命令，不新增 Node 运行时。

## Verification Checklist

- [x] 架构文档与实现边界一致。
- [x] 两个后台硬门禁独立，关闭任一个只影响对应 Provider。
- [x] 自动提交设置按用户 + Provider 隔离且跨重启保持。
- [x] 自动关闭时可人工确认；自动开启时只在有效 session/lease 下提交。
- [x] 自动提交和人工确认提交的系统订单均受同一套冲突、过期和不可成交自动撤单监管。
- [x] Futu 只走本机 OpenD；Longbridge 只走本机官方 CLI/SDK。
- [x] 模型不能直接提交订单，服务端签名 intent 和客户端复核不可绕过。
- [x] 同一 intent 在重试、超时、重复点击和进程重启下最多生成一个券商订单。
- [ ] 订单与回执完整落入 AIDAP，Provider/connection/user 全部匹配。
- [x] 自动化覆盖率门禁通过，普通 CI 零真实下单。
- [x] Futu 与 Longbridge 的 AAPL 真实买入及卖空限价单均获得订单号并完成撤单，
      或明确记录阻断/最终状态。

### 2026-09-30 生产发布与实盘前置检查

- 部署提交 `aa7e20cbc968` 已从 `ECS-0EJj-deploy` 发布；AIDAP migration 013、
  Worker Revision 4 和 Gateway Revision 3 均完成，双 Provider 门禁为 `true`，
  Gateway/Worker gate hash 一致，订单签名配置有效。
- Futu REAL 买入 readiness 通过；卖空因账户处于保证金追缴或高风险状态被券商
  门禁拒绝。
- Longbridge REAL 买入 readiness 通过；卖空因最大可卖空数量为 0、无法确认券源
  被券商门禁拒绝。
- 因双券商卖空前置条件未全部通过，本轮未提交任何真实订单，也未产生需要撤销的
  券商订单号或 AIDAP execution/event。待账户风险和券源恢复后重新执行四单验收。
