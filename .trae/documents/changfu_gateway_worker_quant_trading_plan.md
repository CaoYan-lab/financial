# 长富 Gateway / Decision Worker 量化交易能力补齐计划

## 一、Summary

当前 `changfu-backend` 尚未与旧 Web 后台能力对齐，也不足以支撑桌面端开始实现完整量化交易。

现有实现只完成了认证、Futu 连接注册、交易租约、待确认订单 claim、单次模型请求转发和基础模型运行审计。策略目录、研究标的池、模型选择、提示词选择、候选池、信号、待确认订单生成、订单事件、报告和会话等大部分能力只有数据库预留或 OpenAPI 声明，没有 Gateway 路由、Repository 和端到端实现。Decision Worker 仍使用单一环境模型与硬编码研究提示词，并明确禁止 `ORDER_DRAFT`，因此不能执行量化交易决策链路。

本计划不直接复制旧 Web 后台。旧 Web 中已验证的业务语义迁移到长富独立后台，但保持长富既定边界：

* 桌面客户端负责本机券商连接、实时数据采集、量化调度、本地硬风控和最终订单执行。
* Gateway 负责认证、权益、配置、目录、业务状态、幂等、租约和历史查询。
* Decision Worker 负责按服务端权威配置构建模型请求、执行角色化决策、校验输出、生成信号/候选和签名订单意图。
* Gateway 和 Worker 都不直连 Futu OpenD 或 Longbridge 交易 SDK。
* 模型输出不能直接调用券商下单。自动模式只是跳过人工确认，仍必须经过短租约、桌面重采样、本地硬风控、原子 claim 和结果回传。

## 二、已锁定产品决策

1. Futu 与 Longbridge 使用同一套后台协议和领域模型，`provider` 为显式字段，两者账户、配置、租约、运行状态和历史互相隔离。
2. 先完成 Futu 端到端，再在同一协议下接入 Longbridge；不再创建 Futu 专用的新业务接口。
3. 交易股票池只读研究标的池。桌面端不能单独维护交易池；每轮扫描和 Worker 决策都重新校验研究权益、池版本与标的成员关系。
4. 首期只交易美股/港股正股与 ETF。期权持仓可以进入风险上下文，但模型不得生成期权订单。
5. 提供两种模型交易链路：
   * `DIRECT`：单票决策通过后端和桌面硬风控后直接形成待执行意图。
   * `CANDIDATE_POOL`：单票信号先进入候选池，再由组合裁决模型排序和晋级。
6. 不迁移多角色 TradingAgents，留作后续独立能力。
7. 用户可按券商账户选择 `MANUAL_CONFIRM` 或 `AUTO_EXECUTE`。
8. 自动模式每次应用启动、账户切换、设备切换或租约失效后必须重新确认；保存的只是偏好，不是有效执行授权。
9. 自动模式允许开仓、平仓、回补和撤单，但所有动作都必须通过相同的时段、额度、持仓、订单冲突、滑点、费用、租约和熔断硬校验。
10. 模型按“券商账户 + 决策角色”选择。角色固定为：
    * `SINGLE_DECISION`
    * `PORTFOLIO_REVIEW`
    * `MANAGED_ORDER_REVIEW`
11. 提示词正文只在 Worker 内部使用。桌面端只展示结构化摘要、版本、角色、约束、输出字段、发布时间和内容哈希，不返回完整系统提示词。
12. 模型目录只返回公共模型 ID、名称、能力、延迟档位和套餐可用性；供应商部署 ID、API Key 和调用地址不下发客户端。

## 三、Current State Analysis

### 3.1 当前 Gateway 已实现

文件：`changfu-backend/apps/gateway/src/server.ts`

* `GET /v1/health`
* `POST /v1/auth/login`
* `POST /v1/auth/refresh`
* `POST /v1/auth/logout`
* `GET /v1/ads/active`
* `POST /v1/broker-connections/futu`
* `POST /v1/trading-lease/acquire`
* `POST /v1/trading-lease/renew`
* `POST /v1/pending-orders/{intentId}/claim`
* `POST /v1/model/runs`

### 3.2 当前 Worker 已实现

文件：

* `changfu-backend/apps/decision-worker/src/server.ts`
* `changfu-backend/apps/decision-worker/src/decisionService.ts`

现状：

* 只有 `/internal/v1/health` 和 `/internal/v1/model/runs`。
* 所有 purpose 共用同一套研究提示词，没有单票、组合和挂单监管三个决策器。
* 模型由 `CHANGFU_ARK_MODEL` 单值决定，不能按用户、账户和角色选择。
* 提示词版本来自客户端 `capabilities`，服务端没有权威交易目录。
* Tool Call 只返回“已授权”占位结果，没有执行量化计算或组合裁决。
* Worker 明确提示“当前阶段禁止生成 ORDER_DRAFT”。
* `DecisionService.assertResultSafe` 能校验订单草案形状，但没有创建签名订单意图的实现。

### 3.3 当前数据库与接口不一致

文件：

* `changfu-backend/migrations/001_changfu_schema.sql`
* `changfu-contracts/openapi/changfu-v1.yaml`

数据库已预留 `strategy_configs`、`signals`、`pending_orders`、`order_executions`、`order_events`、`reports`、`conversations`、`messages`，但大多没有 Repository 或 Gateway 路由。

OpenAPI 声明但 Gateway 未实现的接口至少包括：

* `POST /v1/devices/enroll`
* `POST /v1/order-events/batch`
* `POST /v1/conversations`

此外，OpenAPI 完全没有研究权益、研究池、模型目录、策略目录、提示词目录、交易配置、候选池和自动交易会话接口。

### 3.4 当前协议的阻塞项

* `broker_connections.broker` 数据库约束固定为 `FUTU`。
* `context-envelope.schema.json` 中账户 broker 固定为 `FUTU`。
* `signed-order-intent.schema.json` 中订单 broker 固定为 `FUTU`。
* 桌面端 `BackendClient` 只有 Futu 连接注册和模型运行。
* Longbridge 模型上下文被客户端主动关闭。
* `ContextEnvelope 1.0` 没有权威的研究池版本、交易配置版本、目录版本和自动会话 ID。
* Gateway 要求所有 POST 都带幂等键，但尚未实际使用 `idempotency_records` 做请求哈希与响应复用。
* `/v1/model/runs` 返回单行 NDJSON，不是真正的阶段化流。

### 3.5 与旧 Web 后台的能力差距

旧 Web 已具备以下语义，长富独立后台尚未实现：

| 能力 | 旧 Web | 长富当前 |
| --- | --- | --- |
| 模型目录与运行时模型选择 | 已实现 | 缺失 |
| 并发与夜盘模型开关 | 已实现 | 缺失 |
| 策略目录与版本选择 | 已实现 | 仅表预留 |
| Prompt Pack 目录、选择与展示 | 已实现 | 缺失 |
| 直推 / 候选池模式 | 已实现 | 缺失 |
| 单票扫描与信号历史 | 已实现 | 缺失 |
| 候选池、TTL、组合裁决 | 已实现 | 缺失 |
| 待确认订单生成、确认、拒绝、过期 | 已实现 | 只有 claim |
| 自动提交与自动撤单开关 | 已实现 | 缺失 |
| 挂单监管 | 已实现 | 缺失 |
| Futu / Longbridge 双券商 | 已实现但接口分裂 | 后台仅 Futu |
| 报告与会话历史 | 已实现 | 表或契约预留 |

不能直接迁移的旧实现：

* 全局内存单例引擎。
* 固定源码股票池。
* SQLite/Python bridge 配置存储。
* 服务端直连用户券商并直接下单。
* Futu 与 Longbridge 两套分裂路由。
* 允许前端取得完整 Prompt YAML。

## 四、目标架构与数据流

### 4.1 配置与目录

1. Gateway 从 `changfu-backend/catalog/trading/` 加载版本化模型、策略和提示词清单。
2. 目录启动时经过 JSON Schema 校验；任何引用缺失或哈希不一致时 fail closed。
3. 桌面端读取公共目录，按账户和角色保存选择。
4. Gateway 使用乐观锁写入交易配置，并生成不可变 `configVersion`。
5. Decision Worker 每次运行从 PostgreSQL 读取当前权威配置，不信任客户端提交的模型、Prompt 或执行模式。

### 4.2 研究池与交易池

1. Gateway 返回实时研究权益与研究池版本。
2. 桌面端只能从研究池中选择本轮扫描范围，不能创建独立交易池。
3. 客户端在 ContextEnvelope 中携带 `researchPoolVersion` 和请求标的。
4. Worker 在模型调用前重新查询研究池，校验权益、版本和成员关系。
5. 权益过期、池版本变化或标的移除时，本轮失败关闭；旧候选不得继续晋级。

### 4.3 单票直推

1. 桌面端按研究池、市场时段和配置间隔调度本机行情采集。
2. 桌面端构建 `SINGLE_DECISION` 上下文并签名。
3. Gateway 仅内存转发上下文。
4. Worker 读取账户交易配置，选择单票模型、策略和 Prompt。
5. Worker 校验模型输出并写入模型运行与信号。
6. HOLD 只写信号；可交易动作生成签名订单意图和待确认订单。
7. `MANUAL_CONFIRM` 模式等待用户确认。
8. `AUTO_EXECUTE` 模式只有在有效自动交易会话存在时，桌面端才能自动进入 claim 和本地执行。

### 4.4 候选池组合裁决

1. 单票非 HOLD 信号写入 `candidate_pool_items`，不立即生成订单。
2. Gateway 按账户、方向、状态、TTL 和池版本提供候选查询。
3. 桌面端按组合裁决间隔采集候选对应的最新本机行情与账户风险上下文。
4. Worker 运行 `PORTFOLIO_REVIEW`，每个候选必须恰好分类为晋级、观察、抑制或过期。
5. 晋级候选再次经过服务端硬风控后生成签名订单意图。
6. 组合裁决不得修改候选的方向、数量、价格和风险方案，只能分类与排序。

### 4.5 挂单监管

1. 桌面端只上传本系统订单的最新券商状态和必要上下文。
2. Worker 运行 `MANAGED_ORDER_REVIEW`，只允许 `KEEP` 或 `CANCEL_REMAINDER`。
3. 自动撤单同样要求有效自动交易会话和本地券商状态复核。
4. 任何状态未知、归属不明、不可撤或快照过期均返回 KEEP。

### 4.6 自动交易安全链路

自动模式不持久化为“持续授权”，只持久化用户偏好：

1. 用户每次启动或账户切换后在桌面端查看风险摘要并确认。
2. Gateway 创建带 `AUTO_EXECUTE`、`brokerConnectionId`、`deviceId`、`configVersion` 和 `policyVersion` 的短租约。
3. 建议 TTL 为 90 秒，桌面端每 30 秒续租；休眠、断网、切换账户或心跳失败立即失效。
4. 桌面端执行前重新读取账户、持仓、行情和未终态订单。
5. 桌面端验证服务端签名、意图 TTL、研究池版本、配置版本、会话 ID、订单额度和本地策略版本。
6. 原子 claim 成功后才可调用 BrokerHost。
7. BrokerHost 只接受结构化白名单命令，不接受任意 CLI 参数。
8. 提交超时先按 intent remark 和订单字段查单，禁止直接重试。
9. 连续失败、数据过期、行情异常、滑点超限、租约失效或回执不同步触发熔断并降级 `MANUAL_CONFIRM`。

## 五、Proposed Changes

### 5.1 契约与 Schema

修改：

* `changfu-contracts/openapi/changfu-v1.yaml`
* `changfu-contracts/schemas/context-envelope.schema.json`
* `changfu-contracts/schemas/model-result.schema.json`
* `changfu-contracts/schemas/signed-order-intent.schema.json`
* `changfu-contracts/schemas/broker-event.schema.json`
* `changfu-contracts/fixtures/*`

新增：

* `changfu-contracts/schemas/trading-catalog.schema.json`
* `changfu-contracts/schemas/trading-config.schema.json`
* `changfu-contracts/schemas/research-pool.schema.json`
* `changfu-contracts/schemas/candidate-pool.schema.json`
* `changfu-contracts/schemas/trading-session.schema.json`
* `changfu-contracts/schemas/model-run-event.schema.json`

关键变更：

* broker 枚举改为 `FUTU | LONGBRIDGE`。
* ContextEnvelope 升级为 `2.0`，新增：
  * `provider`
  * `researchPoolVersion`
  * `tradingConfigVersion`
  * `catalogVersion`
  * `tradingSessionId`
  * `requestedSymbols`
* 客户端只传配置引用，不传模型供应商 ID、完整 Prompt 或任意工具定义。
* ModelResult 增加 `SIGNAL`、`CANDIDATE`、`ORDER_DRAFT` 的明确结果结构。
* SignedOrderIntent 增加 provider、sessionId、poolVersion、configVersion、riskPolicyVersion、executionMode 和客户端复核字段。
* NDJSON 定义 `accepted`、`progress`、`result`、`error` 四类事件。

兼容策略：

* `ContextEnvelope 1.0` 仅继续支持 CHAT/REPORT。
* 交易 purpose 必须使用 2.0；不做静默降级。

### 5.2 Gateway API

重构 `changfu-backend/apps/gateway/src/server.ts`，按领域拆分 Router，避免继续扩张单文件：

* `apps/gateway/src/routes/brokerConnections.ts`
* `apps/gateway/src/routes/researchPool.ts`
* `apps/gateway/src/routes/tradingCatalog.ts`
* `apps/gateway/src/routes/tradingConfig.ts`
* `apps/gateway/src/routes/tradingSessions.ts`
* `apps/gateway/src/routes/modelRuns.ts`
* `apps/gateway/src/routes/signals.ts`
* `apps/gateway/src/routes/candidates.ts`
* `apps/gateway/src/routes/pendingOrders.ts`
* `apps/gateway/src/routes/orderEvents.ts`
* `apps/gateway/src/routes/reports.ts`
* `apps/gateway/src/routes/conversations.ts`

新增或补齐接口：

#### 券商连接

* `GET /v1/broker-connections`
* `POST /v1/broker-connections`
* `PATCH /v1/broker-connections/{id}`

POST 使用统一 body：`provider`、`accountIdHash`、`environment`、`displayName`。不接收券商密码和 Longbridge 密钥。

#### 研究权益与研究池

* `GET /v1/research/entitlement`
* `GET /v1/research/pool`
* `POST /v1/research/pool/items`
* `DELETE /v1/research/pool/items/{symbol}`
* `POST /v1/research/pool/replacements`

所有写入校验容量、替换周期、市场、重复项和套餐状态，并生成单调递增 pool version。

#### 目录与交易配置

* `GET /v1/trading/catalog?brokerConnectionId=...`
* `GET /v1/trading/config?brokerConnectionId=...`
* `PUT /v1/trading/config/{brokerConnectionId}`

配置字段：

* `executionMode`: `DIRECT | CANDIDATE_POOL`
* `confirmationMode`: `MANUAL_CONFIRM | AUTO_EXECUTE_PREFERENCE`
* `models.singleDecision`
* `models.portfolioReview`
* `models.managedOrderReview`
* `strategyId`
* `singlePromptId`
* `portfolioPromptId`
* `managedOrderPromptId`
* `scanIntervalSeconds`
* `portfolioReviewIntervalSeconds`
* `candidateTtlSeconds`
* `maxConcurrency`
* `disableUsOvernightEvaluation`
* `riskPolicyId`
* `expectedVersion`

返回的 Prompt 只含结构化摘要，不含正文。

#### 自动交易会话

* `POST /v1/trading-sessions/activate`
* `POST /v1/trading-sessions/{id}/renew`
* `POST /v1/trading-sessions/{id}/deactivate`
* `GET /v1/trading-sessions/current?brokerConnectionId=...`

activate 必须携带：

* `brokerConnectionId`
* `deviceId`
* `configVersion`
* `riskPolicyVersion`
* `confirmationDigest`
* `appSessionId`

#### 信号与候选

* `GET /v1/signals`
* `GET /v1/candidates`
* `POST /v1/candidates/{id}/expire`
* `GET /v1/model-runs/{requestId}`

信号和候选由 Worker 写入，客户端只读或执行显式过期操作。

#### 待确认与执行

* `GET /v1/pending-orders`
* `POST /v1/pending-orders/{id}/confirm`
* `POST /v1/pending-orders/{id}/reject`
* `POST /v1/pending-orders/{id}/expire`
* `POST /v1/pending-orders/{id}/claim`
* `POST /v1/order-executions`
* `POST /v1/order-events/batch`

`confirm` 只改变人工确认状态；`claim` 才授予短期执行权。自动模式跳过 confirm，但不跳过 claim。

#### 报告与会话

补齐现有预留：

* `POST /v1/conversations`
* `GET /v1/conversations`
* `GET /v1/conversations/{id}/messages`
* `POST /v1/conversations/{id}/messages`
* `GET /v1/reports`
* `GET /v1/reports/{id}`

### 5.3 Gateway 通用基础设施

新增：

* `packages/http/src/router.ts`
* `packages/http/src/problem.ts`
* `packages/idempotency/src/idempotencyService.ts`
* `packages/catalog/src/tradingCatalog.ts`

要求：

* 所有写接口实际使用 `idempotency_records`，相同键不同请求哈希返回 409。
* GET 不要求 Idempotency-Key。
* 请求体、上下文、Prompt、密钥和完整模型输出禁止进入日志。
* 用户 ID、设备 ID 和资源归属只来自 access token 和数据库。
* 配置更新使用 `expectedVersion` 乐观锁。

### 5.4 数据库迁移与 Repository

新增迁移：`changfu-backend/migrations/002_quant_trading_control_plane.sql`

修改：

* 放宽 `broker_connections.broker` 为 `FUTU | LONGBRIDGE`。
* 保留已有数据和外键，不重建用户数据表。

新增表：

* `research_entitlements`
* `research_pools`
* `research_pool_items`
* `trading_profiles`
* `trading_sessions`
* `candidate_pool_items`
* `candidate_reviews`
* `trading_session_events`

扩展现有表：

* `signals`：增加 role、model public ID、prompt ID、config version、pool version、lifecycle status。
* `pending_orders`：增加 provider、execution mode、trading session ID、confirmation state 和风险策略版本。
* `model_runs`：增加 role、catalog version 和公开模型 ID；仍不保存原始 ContextEnvelope。

新增 Repository：

* `researchPoolRepository.ts`
* `tradingProfileRepository.ts`
* `tradingSessionRepository.ts`
* `signalRepository.ts`
* `candidateRepository.ts`
* `pendingOrderRepository.ts`
* `orderExecutionRepository.ts`
* `conversationRepository.ts`
* `reportRepository.ts`

所有状态变更使用事务、版本列和行锁；候选晋级与 pending order 创建必须原子完成。

### 5.5 版本化交易目录

新增目录：

* `changfu-backend/catalog/trading/models.yaml`
* `changfu-backend/catalog/trading/strategies/*.yaml`
* `changfu-backend/catalog/trading/prompts/*.yaml`
* `changfu-backend/catalog/trading/risk-policies/*.yaml`
* `changfu-backend/catalog/schemas/*.json`

迁移旧 Web 已验证语义：

* 三角色模型选择。
* 机构风控兜底策略。
* 实盘保守单票 Prompt。
* 候选池组合裁决 Prompt。
* 挂单监管 Prompt。
* 直推和候选池模式。

不迁移：

* 完整 Prompt 下发。
* SQLite/Python bridge。
* 环境变量直接覆盖用户选择。
* 固定源码股票池。

目录发布规则：

* ID 和版本不可原地修改。
* Prompt 正文、摘要与输出契约分别存储。
* 启动时计算内容哈希。
* 下线条目不能用于新配置，但历史运行仍可解析。
* 模型公共 ID 映射到 Worker 私有部署配置。

### 5.6 Decision Worker

新增：

* `apps/decision-worker/src/configResolver.ts`
* `apps/decision-worker/src/promptResolver.ts`
* `apps/decision-worker/src/models/modelRouter.ts`
* `apps/decision-worker/src/decisions/singleDecision.ts`
* `apps/decision-worker/src/decisions/portfolioReview.ts`
* `apps/decision-worker/src/decisions/managedOrderReview.ts`
* `apps/decision-worker/src/validation/tradingResultValidator.ts`
* `apps/decision-worker/src/signing/orderIntentSigner.ts`
* `apps/decision-worker/src/services/tradingDecisionService.ts`

改造：

* `apps/decision-worker/src/server.ts`
* `apps/decision-worker/src/decisionService.ts`
* `apps/decision-worker/src/modelResultNormalizer.ts`

执行顺序：

1. 验证 ContextEnvelope 2.0、设备签名、时效和大小。
2. 从数据库验证设备、券商连接、研究权益和股票池。
3. 读取当前交易配置和目录，不信任客户端配置引用。
4. 按 role 选择模型、Prompt 和输出 Schema。
5. 调用模型并进行严格 JSON Schema 校验。
6. 进行服务端硬风控与证据归属校验。
7. 事务写入 model run、signal、candidate 或 pending order。
8. 需要执行时生成短 TTL 的签名订单意图。
9. 返回阶段化 NDJSON，不返回 Prompt 正文或供应商配置。

失败策略：

* 未知模型、策略、Prompt、版本错配：拒绝运行。
* 池版本变化或标的不在池：拒绝运行。
* 关键行情缺失或过期：HOLD，不创建意图。
* 模型格式非法：记录 REJECTED，不从自由文本恢复订单。
* Candidate Pool 没有合格候选：正常完成，晋级列表为空。
* 签名服务不可用：保留信号，禁止创建 pending order。

### 5.7 桌面客户端后台接入

修改：

* `changfu-desktop/macos/Infrastructure/BackendClient.swift`
* `changfu-desktop/macos/App/AppState.swift`
* `changfu-desktop/macos/Domain/ResearchModels.swift`
* `changfu-desktop/macos/Domain/WorkspaceModels.swift`
* `changfu-desktop/macos/App/FutuWorkspaces.swift`
* `changfu-desktop/macos/App/RootView.swift`

新增：

* `Domain/TradingControlModels.swift`
* `Infrastructure/TradingControlClient.swift`
* `App/TradingConfigurationView.swift`
* `App/QuantTradingRuntimeView.swift`
* `App/CandidatePoolView.swift`
* `App/PendingOrderConfirmationView.swift`
* `App/PromptSummaryView.swift`

UI 结构：

1. 交易页顶部：券商账户、配置版本、研究池版本、运行状态、人工/自动状态。
2. 研究池：只读显示当前研究池、权益、容量、版本和锁定状态；管理动作跳转研究页。
3. 策略链路：分段选择直推或候选池。
4. 三角色模型：单票、组合、挂单分别选择。
5. 策略与提示词：选择版本并展示结构化摘要、约束、输出字段和哈希。
6. 调度配置：扫描间隔、组合复核间隔、并发和美股夜盘开关。
7. 风控摘要：展示实际生效的服务端策略，不允许客户端放宽。
8. 运行控制：启动、停止、单次运行。
9. 自动交易：独立高风险开关，每次应用启动重新确认。
10. 下半区：信号、候选池、待确认订单、执行记录与熔断状态。

客户端不得：

* 缓存完整 Prompt。
* 自行扩展研究池。
* 将 Longbridge 上下文注册为 Futu。
* 在租约失效后继续自动执行。
* 因后端不可用而回退到本地默认模型或默认策略。

### 5.8 BrokerHost 执行协议

新增共享 DTO：

* `BrokerCommandEnvelope`
* `SubmitOrderCommand`
* `CancelOrderCommand`
* `OrderLookupCommand`
* `BrokerCommandResult`

修改：

* `changfu-desktop/macos/Infrastructure/FutuBrokerClient.swift`
* `changfu-desktop/macos/Infrastructure/LongbridgeBrokerClient.swift`
* `changfu-desktop/macos/BrokerHost/main.swift`
* `changfu-desktop/macos/LongbridgeHost/main.swift`

要求：

* Host 命令白名单固定，不接受任意命令名和参数。
* 凭据仍通过系统安全存储和一次性 stdin 传递。
* Host 不验证模型语义，只执行已经由主 App 完成本地复核的结构化命令。
* Futu 与 Longbridge 分别实现相同协议，不共享连接状态。
* 首次上线先开放模拟/影子和人工确认；自动执行在完整熔断测试通过后由服务端功能标志开放。

### 5.9 架构主文档

实施时同步更新：

* `.trae/documents/changfu_desktop_architecture_plan.md`

必须修正：

* “当前阶段不实现自动下单”改为用户可选自动/人工，但自动模式每次启动重确认。
* Longbridge 后台 provider、上下文和交易能力边界。
* 交易池只读研究池。
* 三角色模型与结构化 Prompt 摘要。
* Gateway / Worker 实际完成状态，移除把预留表或 OpenAPI 当作已实现能力的描述。

## 六、实施顺序

### Phase 1：协议与控制面

1. 完成契约 2.0、目录 Schema 和迁移 002。
2. 实现统一 broker connection、研究池、目录和交易配置 API。
3. 实现 Repository、乐观锁和真实幂等。
4. 桌面端接入只读目录与配置 UI。

完成标准：桌面端能读取研究池、选择三角色模型、策略、Prompt 摘要和执行链路，并可靠保存版本化配置。

### Phase 2：影子量化决策

1. 实现 Worker 三角色路由与服务端配置解析。
2. 完成 SINGLE_DECISION 的 HOLD/SIGNAL。
3. 完成 CANDIDATE_POOL 写入与 PORTFOLIO_REVIEW。
4. 桌面端实现本地调度、运行状态、信号和候选展示。

完成标准：双券商协议一致；Futu 实盘数据可运行影子决策，不创建可执行订单。

### Phase 3：人工确认交易

1. 实现签名订单意图、pending order、确认/拒绝/过期。
2. 实现 claim、BrokerHost 提交、回执和事件同步。
3. 实现提交超时查单与幂等恢复。
4. 完成 Futu 人工确认端到端，再接 Longbridge。

完成标准：用户确认后最多产生一笔券商订单，任何失败可审计、可恢复。

### Phase 4：自动交易门禁

1. 实现每次启动确认、短租约和心跳。
2. 实现自动开平仓与撤单。
3. 实现熔断、降级人工、休眠/断网/切换账户处理。
4. 通过模拟账户和小规模灰度后才开放 REAL 功能标志。

完成标准：租约或任一关键数据失效时零自动订单；重复请求最多产生一笔订单。

### Phase 5：历史、报告与会话

1. 补齐信号、候选、订单、执行和模型运行历史。
2. 补齐报告和会话 API。
3. 策略中心接入持久化数据。

## 七、Assumptions & Decisions

* 旧 Web 是行为参考，不是可导入依赖。
* PostgreSQL 是唯一服务端持久化来源；不新增 SQLite 配置桥。
* 桌面端本地券商快照仍不长期上传或落库。
* 信号、候选、订单意图、回执、报告和对话允许长期保存。
* 研究池由套餐权益控制；本计划实现接口和校验，支付系统可后续提供权益来源。
* 模型配置由服务端管理，客户端只能选择公开目录项。
* Prompt 正文属于服务端运行资产，桌面端只看摘要。
* 自动交易不是默认值；没有本次应用会话的明确确认时一律人工模式。
* Futu 与 Longbridge 市场状态、报价和执行通道继续完全隔离。
* 美股和港股交易时段独立判断。

## 八、Verification

### 8.1 契约

* OpenAPI 所有声明路由都有 Gateway 实现和集成测试。
* Schema 覆盖 Futu/Longbridge、三角色、两种执行链路和两种确认模式。
* 1.0 CHAT/REPORT 兼容，1.0 交易请求明确拒绝。
* 未知字段、未知目录项、版本错配和伪造 provider 全部失败关闭。

### 8.2 Gateway

* 用户、设备、券商连接和资源归属隔离测试。
* Idempotency-Key 同键同请求复用响应，同键不同请求返回冲突。
* 研究池容量、替换周期、版本并发和权益过期测试。
* 配置乐观锁、目录下线和套餐模型限制测试。
* 自动交易会话启动、续租、过期、休眠和账户切换测试。

### 8.3 Worker

* 三角色黄金样例与恶意模型输出测试。
* Prompt、模型和策略只从服务端权威配置解析。
* 标的池外代码、旧 pool version 和旧 config version 均拒绝。
* HOLD、candidate、promotion、KEEP/CANCEL 和签名意图完整覆盖。
* 原始 ContextEnvelope、Prompt 正文和密钥不出现在数据库、日志与错误。
* Worker 中断后 model run 正确标记 INTERRUPTED，不遗留可执行意图。

### 8.4 订单

* 人工和自动模式都必须经过 claim 与桌面本地复核。
* 重复确认、重复 claim、提交超时重试最多产生一笔券商订单。
* 部分成交、完全成交、拒单、撤单、不可撤和费用回填完整覆盖。
* 自动租约失效、行情过期、滑点超限和订单冲突均不提交。
* 自动模式熔断后立即降级人工，不自动恢复。

### 8.5 双券商与市场

* 同一用户的 Futu/Longbridge 配置、租约、信号和订单互不污染。
* 港股不会继承美股夜盘状态。
* Longbridge 不再冒充 Futu 注册上下文。
* 两个 BrokerHost 对同一规范命令返回同一领域结果结构。

### 8.6 UI

* 1440×900、当前大屏、对话展开/折叠均无溢出。
* 交易配置使用与现有 Futu 工作区一致的字体、间距、表格和模块高度。
* 自动交易状态始终醒目，不能与“保存了自动偏好”混淆。
* Prompt 摘要显示版本、哈希、约束和输出字段，不显示正文。
* 无权益、无研究池、后端离线或目录异常时不显示默认假配置。

### 8.7 门禁

* Backend 行覆盖率高于 90%。
* Domain 行覆盖率 100%。
* Schema、迁移、Gateway、Worker、桌面客户端、BrokerHost 和 UI 契约全部进入 CI。
* 自动 REAL 交易在模拟账户、故障注入、重复提交和断网恢复测试通过前保持服务端功能标志关闭。

## 九、实施状态

### 2026-09-19 Phase 1

已完成：

* ContextEnvelope 2.0、双 provider、SignedOrderIntent 2.0 和六类新增领域 Schema。
* migration 002：目录版本、研究权益/池、交易配置版本、候选池和短期自动交易会话。
* 版本化服务端交易目录、Prompt 哈希校验和公共字段脱敏。
* 统一 broker connection、研究池、交易目录、交易配置、自动交易会话 Gateway API。
* 基于 `idempotency_records` 的请求哈希、响应复用与同键异请求冲突。
* 桌面端统一注册 Futu/Longbridge，并只读加载目录、配置和研究池。
* Backend 21 项测试、10 个 Schema 契约检查、Swift 53 项桌面测试和完整 Swift 包构建。

### 2026-09-19 Phase 2

已完成：

* Worker 三角色路由与服务端权威配置解析；逐次校验券商归属/provider、目录、配置版本、研究权益、研究池版本和标的成员。
* SINGLE_DECISION 的 HOLD/SIGNAL/CANDIDATE 严格归一化；CANDIDATE_POOL 的信号与候选由服务端事务写入并生成 ID、TTL 和版本绑定。
* PORTFOLIO_REVIEW 从数据库读取账户内有效候选，要求每个候选恰好分类一次；过期候选由服务端先行标记。
* MANAGED_ORDER_REVIEW 已具备独立模型/Prompt 路由和 KEEP/CANCEL_REMAINDER 结构校验，但 Phase 2 只记录影子建议。
* 任何交易角色返回 ORDER_DRAFT 都失败关闭；本阶段不创建 pending order、不 claim、不调用 BrokerHost。
* Gateway 增加 model run、signal、candidate 查询，并将 Worker 输出升级为 accepted/progress/result/error NDJSON。
* 桌面端新增 ContextEnvelope 2.0 交易工厂、手动/定时影子调度、信号/候选/运行记录展示；Futu 与 Longbridge 使用同一协议。
* 桌面端量化评估按标的隔离任务结果；报价或最小趋势窗口不足时不发送模型请求，单票失败不取消同批任务，定时调度继续后续轮次。顶部摘要与独立详情弹窗按 Web 口径展示每个标的的可评估、暂不评估或待重试原因。
* 市场情报证据统一使用后端注册的 `RISK` 类型，禁止 `POLICY` 或事件分组名作为 `evidenceCatalog.kind`。
* 本地启动脚本自动执行幂等 migration 001/002；源码与 `dist` 运行均可定位版本化交易目录。
* Backend 24 项测试、10 个 Schema 契约检查、Swift 54 项桌面测试和完整 Swift 包构建通过。

后续审计补充：

* 当前长富 Worker 的交易 Prompt 并非旧 Web 生产 Prompt 的原文迁移。两套 Prompt、作者来源、上下文字段、证据目录和建议补数优先级详见 [长富桌面影子决策与旧 Web 交易提示词、上下文对比](./changfu_trading_prompt_context_comparison.md)。
* 模型运行 UI 改为分层审计视图：结论常驻；证据/反证、风险/数据缺口成对展示；退出条件独立展示；最新记录默认展开，历史记录默认收起。
* “模型未提供可验证证据”是 Worker 协议降级记录，不是模型生成的市场证据；“缺少相关新闻”是模型在当前开放式 `dataGaps` 下自行提出的缺口，不是旧 Web Prompt 的固定要求。

仍待 Phase 3：

* 签名订单意图与 pending order 生成、确认/拒绝/过期。
* BrokerHost 结构化下单、回执同步、超时查单和端到端幂等恢复。
* 在具备 PostgreSQL、Ark 与真实 Futu 账户的环境完成影子运行验收；本机自动化通过不等同于实盘验收。
