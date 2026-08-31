# Longbridge 量化交易工作台设计计划

## Summary

目标不是继续展示 Longbridge Skills 能力清单，而是把 `/longbridge` 做成与 `/futu` 工作台内容结构基本一致的长桥证券量化交易工作台：

- 复用 Futu 工作台的信息架构和主要模块。
- 去掉模拟盘模块。
- 保留账户资产、持仓、风险、数据源、研究机会、报告中心、自选/观察、实盘量化入口。
- Longbridge 实盘量化中，大模型收到的行情订阅、K 线、盘口、分时、持仓、账户资产、购买力、订单能力等数据，必须来自 Longbridge SDK / Skill / CLI / MCP 支持的数据接口。
- Longbridge 行情与 K 线不应长期依赖每轮 CLI 现拉；正确形态是参考 Futu 的订阅回调缓存模式：后台 SDK 订阅股票池，回调写入本地缓存，LLM 并发评估读取缓存，CLI/MCP 仅作为冷启动补拉和降级兜底。
- Longbridge 与 Futu 平台隔离，不能让 Longbridge 逻辑污染 Futu 现有链路。
- 本阶段已进入实现：先将 SDK 订阅缓存模式记录到本文档，再按 Longbridge 独立模块落地，不修改 Futu 链路。

## Current State Analysis

### 1. 当前 Futu 工作台形态

文件：`src/pages/Dashboard.tsx`

当前 `/futu` 渲染 `Dashboard`，模块结构为：

- `CommandCenterHeader`
- `AccountSummaryPanel`
- `PositionsPanel`
- `RiskExposurePanel`
- `DataSourcePanel`
- `OpportunityCommandPanel`
- `ResearchReportPanel`
- `WatchlistPanel`
- `LiveTradingPanel`
- `SimulationTradingPanel`
- `StatusTimeline`

用户要求 Longbridge 内容与 Futu 工作台一致，但去掉模拟盘，因此 Longbridge 页面应复用上述结构中的绝大部分模块，排除：

- `SimulationTradingPanel`

### 2. 当前 Futu 数据链路

Futu 当前不是依赖本地安装的 AI Skill 在运行，而是已经被项目封装成后端接口和 Python Bridge：

- `api/routes/accountRoutes.ts`
  - `/api/account/dashboard`
  - `/api/account/summary`
  - `/api/account/positions`
  - 调用 `runPythonBridge('futu_account.py')`
- `api/providers/futuOpenDProvider.ts`
  - `getStatus()`
  - `fetchMarketSnapshot()`
  - 通过 `futu_status.py`、`futu_snapshot.py` 获取 Futu OpenD 状态和行情快照。
- `api/realtime/realtimeSubscriptionService.ts`
  - 通过 `futu_realtime_subscribe.py` 维护实时订阅。
  - 将 quote / ticker / kline / orderBook 写入 `realtimeStore`。
- `api/simulation/realtimeDataAdapter.ts`
  - `loadStrategyMarketData()` 从 `realtimeStore` 读取 Futu 回调缓存。
  - 大模型实盘决策依赖：
    - 最新价
    - 1 分钟 K 线
    - 分时点
    - 盘口 bid / ask
    - 市场状态
- `api/live/liveAccountService.ts`
  - `loadLiveAccountDashboard()` 读取真实账户和持仓，并标准化为 `LiveAccountDashboardResponse`。
- `api/live/liveTradingEngine.ts`
  - 调用 `loadLiveAccountDashboard()`、`loadStrategyMarketData()`、`loadTrendContext()`。
  - 把账户、持仓、行情、趋势、风险模型传给 `requestLiveTradingDecision()`。
  - 生成候选、组合裁决、待确认订单。
- `api/live/liveTradingDecisionService.ts`
  - `buildLiveDecisionPrompt()` 将 Futu 账户、持仓、行情、盘口、K 线、趋势上下文写入 LLM Prompt。

结论：Futu Skill 的角色是历史参考和能力来源，但运行时能力已经沉淀为项目内接口、Python Bridge、TypeScript service、共享类型和前端 hooks。

### 3. 当前 Longbridge 状态

已安装 Longbridge 能力：

- CLI 本地路径：`.tools/longbridge/longbridge`
- CLI 版本：`longbridge 0.23.3`
- Skill 参考文档：`.trae/documents/longbridge_skills_reference.md`
- 已安装 13 个 Longbridge Skills：
  - `longbridge`
  - `longbridge-market-data`
  - `longbridge-technical`
  - `longbridge-quant`
  - `longbridge-portfolio`
  - `longbridge-research`
  - `longbridge-earnings`
  - `longbridge-fundamentals`
  - `longbridge-content`
  - `longbridge-derivatives`
  - `longbridge-watchlist`
  - `longbridge-intel`
  - `longbridge-value-investing`

当前授权状态：

- `.tools/longbridge/longbridge auth status`
- 返回 `Token Status not found`
- 说明 CLI 和 Skill 文件已装载，但真实账户、持仓、订单类能力仍需 OAuth 登录。

当前 `/longbridge` 页面：

- 文件：`src/pages/LongbridgeWorkbenchPlaceholder.tsx`
- 目前展示 Longbridge Skill 能力矩阵。
- 这与用户目标不一致，页面过于冗余。
- 需要改为像 Futu 工作台一样的工作台 UI，而不是 Skill 清单页。

### 4. Longbridge Skill / CLI 能力边界

从已安装 Skill 可确认：

- `longbridge-market-data`
  - 可提供 quote、kline、depth、trades、intraday、capital、market-status、trading、subscriptions 等能力。
  - 多数行情能力可匿名读取。
  - `subscriptions` 需要 session token。
- `longbridge-portfolio`
  - 可提供 assets、portfolio、positions、margin-ratio、max-qty、order、dca 等能力。
  - `assets`、`portfolio` 等需要 Quote permission。
  - `positions`、`order`、`statement` 等需要 Trade permission。
  - `order`、`dca` 是 mutating 操作，必须先展示 preview 并等待明确确认。
- `longbridge`
  - 是核心入口，支持 quote、positions、portfolio、assets、kline、intraday、news、filing、financial-statement、analyst-estimates 等命令。
- MCP fallback
  - Skill 文档明确：CLI 不可用时可使用 Longbridge MCP server，运行时发现工具列表。

结论：Longbridge 应以 SDK / Skill / CLI / MCP 作为数据源能力目录，但项目运行时仍需要一层后端适配器。行情流式数据优先由 Longbridge SDK WebSocket 订阅写入本地缓存；CLI/MCP 输出只作为补拉、账户/订单能力和 SDK 不可用时的降级路径，再供前端和 LLM 使用。

### 5. Longbridge SDK 订阅缓存模式

Futu 的实盘评估不是在 26 并发 LLM 决策时同步发起 26 组行情请求，而是通过 OpenD 订阅回调持续写入 `realtimeStore`，决策时读取本地缓存。因此 Longbridge 也必须采用相同逻辑，否则会出现：

- LLM 并发需要 26，但 Longbridge API/CLI 为避免超时只能小并发，导致数据供给与决策并发不匹配。
- 每个标的同步拉 quote、K 线、盘口、成交 ticks、趋势 K 线，会在股票池评估时放大为大量 CLI 子进程和网络请求。
- 并发现拉失败时，模型收到 `trendContext.available=false`，容易触发不必要的 HOLD。

Longbridge CLI 文档已确认：CLI 不提供 WebSocket subscription push，实时推送需要使用 SDK。因此架构调整为：

1. 后台启动 Longbridge SDK 订阅服务。
2. 订阅当前实盘股票池的 quote、candlestick/K 线、depth、trades。
3. SDK 回调写入 Longbridge 独立 realtime cache。
4. `run-once` / `start` 的 LLM 评估从 cache 读取行情、K 线、盘口、分时和趋势窗口。
5. 当 cache 冷启动、过期或缺字段时，才使用 CLI/MCP 小并发补拉。
6. LLM 并发仍由策略配置控制；Longbridge 数据请求并发只约束补拉，不约束已缓存数据的评估并发。

已新增/落地文件：

- `api/longbridge/longbridgeRealtimeStore.ts`
  - 保存 quote、K 线、盘口、成交 ticks、订阅状态、最后更新时间。
- `api/longbridge/longbridgeRealtimeSubscriptionService.ts`
  - 管理 Longbridge SDK QuoteContext 生命周期。
  - 根据股票池增量订阅/取消订阅。
  - 将 SDK 回调标准化后写入 `longbridgeRealtimeStore`。
- `api/longbridge/longbridgeRealtimeDataAdapter.ts`
  - 优先从 `longbridgeRealtimeStore` 构造 `LongbridgeStrategyMarketData` 和 `TrendContextSummary`。
  - cache 不足时调用 `longbridgeMarketDataService` 作为补拉兜底。

实现状态：

- `LongbridgeStrategyMarketData.source` 已扩展为 `longbridge-sdk-cache | longbridge-cli`。
- `/api/longbridge/realtime/:symbol` 已改为 cache-first 读取。
- `/api/longbridge/realtime/status/subscription` 返回 SDK 订阅状态，缺少 SDK env 时明确标记 degraded。
- 长桥实盘 `start` 先确保股票池 SDK 订阅/种子补拉，再按策略配置的 LLM 并发评估；不再用 Longbridge 数据请求并发限制 LLM 并发。
- `run-once` 对单个标的先尝试 SDK cache，cache 冷启动或不足时再用 CLI 补拉。

运行要求：

- Longbridge SDK 订阅服务必须独立于 Futu `realtimeSubscriptionService`。
- Longbridge cache 不能写入 Futu `realtimeStore`。
- SDK 不可用或授权缺失时，页面必须显示 Longbridge 订阅不可用，并降级为 CLI 补拉模式。
- 实盘 `start` 时先确保股票池订阅已启动，再启动 LLM 调度。

## Proposed Changes

### 1. 将 Longbridge 页面改为工作台页面

文件：`src/pages/LongbridgeWorkbenchPlaceholder.tsx`

计划改造为 `LongbridgeWorkbenchView`，或保留文件名但重写内容。

页面结构参考 `src/pages/Dashboard.tsx`：

- 顶部跨平台导航保持与 Futu 一致：
  - 返回平台选择
  - 进入 Futu 工作台
- 主工作台内容：
  - `CommandCenterHeader` 等价的 Longbridge 标题区
  - `AccountSummaryPanel`
  - `PositionsPanel`
  - `RiskExposurePanel`
  - Longbridge 数据源状态面板
  - `OpportunityCommandPanel`
  - `ResearchReportPanel`
  - `WatchlistPanel`
  - Longbridge 实盘量化入口面板
  - `StatusTimeline`
- 去掉：
  - `SimulationTradingPanel`

建议新增轻量页面组件：

- `src/pages/LongbridgeWorkbenchView.tsx`

保留 `/longbridge` 路由指向新页面。

### 2. 新增 Longbridge 前端 hooks

新增：

- `src/hooks/useLongbridgeDashboard.ts`
- `src/hooks/useLongbridgeReportGeneration.ts`
- `src/hooks/useLongbridgeTrading.ts`

职责：

- `useLongbridgeDashboard`
  - 调用 `/api/longbridge/account/dashboard`
  - 返回与 `useAccountDashboard()` 相同或兼容的数据结构。
- `useLongbridgeReportGeneration`
  - 调用 `/api/longbridge/source/status`
  - 调用 `/api/longbridge/report/latest`、`/api/longbridge/report/history` 等后续接口。
  - 初期可复用现有报告历史 UI，但数据源标识必须是 Longbridge。
- `useLongbridgeTrading`
  - 调用 `/api/longbridge/live-trading/dashboard`
  - 调用 `/api/longbridge/live-trading/start`、`stop`、`run-once`
  - 不复用 Futu 的 `/api/live-trading/*`，避免平台污染。

### 3. 新增长桥后端路由命名空间

新增：

- `api/routes/longbridgeRoutes.ts`

挂载：

- `api/app.ts`
  - `app.use('/api/longbridge', longbridgeRoutes)`

路由设计：

- `GET /api/longbridge/source/status`
  - 返回 Longbridge CLI 是否存在、版本、auth status、已安装 skill 状态、MCP fallback 配置状态。
- `GET /api/longbridge/account/dashboard`
  - 返回 `AccountDashboardResponse` 兼容结构。
  - 使用 `longbridge assets`、`longbridge portfolio`、`longbridge positions` 标准化账户、资产、持仓。
- `GET /api/longbridge/realtime/:ticker`
  - 返回 `RealtimeStockResponse` 兼容结构。
  - 使用 quote、intraday、kline、depth/trades 等 CLI 数据合成。
- `POST /api/longbridge/realtime/subscribe`
  - 如果 CLI 支持 subscription 且授权可用，开启订阅。
  - 如果 subscription 不可用，降级为轮询 quote / kline / depth。
- `GET /api/longbridge/live-trading/dashboard`
- `POST /api/longbridge/live-trading/start`
- `POST /api/longbridge/live-trading/stop`
- `POST /api/longbridge/live-trading/run-once`
- `GET /api/longbridge/live-trading/history/:kind`
- `POST /api/longbridge/live-trading/pending-orders/:id/confirm`
- `POST /api/longbridge/live-trading/pending-orders/:id/reject`
- `POST /api/longbridge/live-trading/pending-orders/batch-expire`

原则：

- Longbridge 使用独立 API namespace。
- 不复用 `/api/live-trading`。
- 不向 Futu live persistence 写入 Longbridge 订单。

### 3.1 新增长桥前端页面路由

Futu 工作台当前不仅有 `/futu` 一级工作台，还包含多个从工作台进入的二/三级页面。Longbridge 需要对应的独立页面路由，避免用户点击后回到 Futu 页面或读取 Futu 数据。

已补齐的 Longbridge 页面路由：

- `/longbridge`
  - 长桥工作台首页。
  - 对应 Futu `/futu`。
- `/longbridge/live-trading`
  - 长桥实盘量化入口。
  - 对应 Futu `/live-trading`。
- `/longbridge/reports`
  - 长桥研究报告中心。
  - 对应 Futu `/reports`。
- `/longbridge/reports/:batchId`
  - 长桥报告详情页。
  - 对应 Futu `/reports/:batchId`。
- `/longbridge/opportunities`
  - 长桥机会历史页。
  - 对应 Futu `/opportunities`。
- `/longbridge/top30-prompt`
  - 长桥策略 Prompt 查看页。
  - 对应 Futu `/top30-prompt`。

实现原则：

- 页面可在第一版先展示 Longbridge Adapter 状态和“等待接入”空状态，但不能跳转到 Futu 的报告、机会、实盘、订单详情页面。
- `/longbridge/live-trading` 需要在单页内复刻 Futu 实盘 UI，包括大模型直推和组合策略；不再设计或暴露订单详情下级页面。
- 所有 Longbridge 页面返回入口统一回到 `/longbridge`。
- 所有 Longbridge 二/三级页面保留跨平台入口：
  - 返回平台选择 `/`
  - 进入 Futu 工作台 `/futu`
- 后续接入真实数据时，页面只调用 `/api/longbridge/*` namespace。

### 4. 新增 Longbridge CLI 执行层

新增：

- `api/longbridge/longbridgeCli.ts`

职责：

- 自动定位 CLI：
  - 优先 `.tools/longbridge/longbridge`
  - 其次 PATH 中的 `longbridge`
- 统一执行：
  - `runLongbridgeCli(args, options)`
  - 支持 timeout。
  - 支持 JSON 输出优先。
  - stderr 原样记录。
  - 命令失败时返回结构化错误。
- 禁止前端直接执行 CLI。
- 对 mutating 命令建立 allowlist：
  - 初期只允许 read-only 命令。
  - order / dca 只能由交易确认接口调用，且必须带用户确认记录。

### 5. 新增 Longbridge 数据适配器

新增：

- `api/longbridge/longbridgeAccountService.ts`
- `api/longbridge/longbridgeMarketDataService.ts`
- `api/longbridge/longbridgeRealtimeAdapter.ts`
- `api/longbridge/longbridgeProvider.ts`
- `api/longbridge/longbridgeTradingEngine.ts`
- `api/longbridge/longbridgeOrderQueueService.ts`
- `api/longbridge/longbridgePersistence.ts`
- `api/longbridge/longbridgeOrderService.ts`

#### 5.1 Account Adapter

输入：

- `longbridge assets`
- `longbridge portfolio`
- `longbridge positions`

输出：

- `AccountDashboardResponse` 或新增 `LongbridgeAccountDashboardResponse`，但字段保持前端组件兼容：
  - `summary`
  - `positions`
  - `risk`
  - `trading`
  - `missingCapabilities`

映射重点：

- Longbridge 账户币种、购买力、现金、总资产字段需要显式保留来源。
- 持仓需映射到 `Position`：
  - `ticker`
  - `name`
  - `assetType`
  - `quantity`
  - `marketValue`
  - `averageCost`
  - `currentPrice`
  - `todayPnL`
  - `unrealizedPnL`
  - `pnlRatio`
  - `positionRatio`
  - `currency`

#### 5.2 Market Data Adapter

输入：

- `longbridge quote SYMBOL.MARKET`
- `longbridge intraday SYMBOL.MARKET`
- `longbridge kline history SYMBOL.MARKET ...`
- `longbridge depth SYMBOL.MARKET`
- `longbridge trades SYMBOL.MARKET`
- `longbridge market-status`

输出兼容：

- `RealtimeStockResponse`
- `StrategyMarketData`
- `TrendContextSummary`

大模型实盘决策需要的数据：

- 最新价：quote
- 分时：intraday
- K 线：kline
- 盘口：depth
- 成交 ticks：trades，可作为 `tickerPoints` 或补充分时上下文
- 市场状态：market-status / trading

若 Longbridge subscription 可用：

- 优先使用 subscription。

若 subscription 不可用或未授权：

- 使用轮询模式：
  - quote：每轮 run-once 前拉取
  - kline：按 dataWindow 拉取足量 bars
  - depth：每轮 run-once 前拉取
  - intraday/trades：按需拉取

#### 5.3 Report / Research Adapter

Longbridge 的研究报告、机会分析可使用：

- `longbridge-market-data`
- `longbridge-fundamentals`
- `longbridge-research`
- `longbridge-content`
- `longbridge-earnings`
- `longbridge-intel`
- `longbridge-value-investing`

但第一阶段不必完全复制 Top 30 CSP 报告逻辑。建议先保留 Futu 工作台上的报告 UI 结构，数据源状态和文案切到 Longbridge，并逐步替换后端 provider。

### 6. 新增长桥实盘量化引擎

新增：

- `api/longbridge/longbridgeTradingEngine.ts`

设计上参考 `api/live/liveTradingEngine.ts`，但不要直接继承 Futu 类。

核心流程：

1. 读取 Longbridge 账户与持仓。
2. 为票池拉取 Longbridge 行情：
   - quote
   - kline
   - depth
   - intraday/trades
   - market-status
3. 标准化为 `StrategyMarketData`。
4. 构造趋势上下文。
5. 调用与 Futu 相同的大模型决策框架，但 system/task 文案改为 Longbridge。
6. 将 LLM 的 BUY / SELL_SHORT / SELL_TO_CLOSE / HOLD 结果写入 Longbridge 独立信号队列。
7. 使用候选池组合裁决。
8. 只生成 Longbridge 待确认订单。
9. 用户确认后才调用 Longbridge order 命令。

注意：

- 模拟盘不实现。
- 不自动下单。
- 订单 mutation 必须独立门禁，例如：
  - `LONGBRIDGE_LIVE_TRADING_ENABLED=true`
  - `LONGBRIDGE_ORDER_CONFIRMATION_REQUIRED=true`
- 后续真实提交订单前，必须先检查 `longbridge-portfolio` order 命令实际参数和 dry-run/preview 能力。

### 7. Prompt 与策略配置平台化

当前 Futu prompt 里写死了大量 Futu 语义：

- `Futu REAL`
- `Futu 最大购买力`
- `Futu order_fee_query`
- `Futu` 交易币种说明

需要新增平台维度：

- `trade_strategy/prompt_packs/llm_autonomous_stock_trader_longbridge_live_safe_v1.yaml`
- 可复用现有策略结构，但系统提示、任务说明、数据来源说明改为 Longbridge。
- 必须明确：
  - 数据来源为 Longbridge Skill / CLI / MCP。
  - 真实订单必须进入待确认队列。
  - 不允许模型直接触发订单提交。
  - 卖空、保证金、订单修改/撤单都需要人工确认。

组合裁决 Prompt：

- 可复用 `live_portfolio_candidate_review_v1.yaml` 的决策原则。
- 需要新增 platform 字段或 prompt 文案说明：
  - Futu / Longbridge 都适用组合裁决。
  - pendingOrders 不能作为唯一 suppress 理由。

建议改造：

- `getActivePromptPack(platform, mode)`
- `getTradeStrategyRuntimeConfig(platform, mode)`
- 或保守新增：
  - `getActiveLongbridgePromptPack()`
  - `getTradeStrategyRuntimeConfig('longbridge-live')`

### 8. 前端组件复用策略

建议抽象一个平台化工作台壳：

- `src/pages/PlatformWorkbenchView.tsx`

参数：

- `platform: 'futu' | 'longbridge'`
- `title`
- `subtitle`
- `theme`
- `useDashboard`
- `useReportGeneration`
- `TradingPanel`
- `showSimulation: boolean`

实施顺序建议先不要大重构：

第一阶段：

- 新建 `LongbridgeWorkbenchView.tsx`
- 直接复制 `Dashboard.tsx` 的布局，去掉 `SimulationTradingPanel`。
- 用 Longbridge hooks 替换 Futu hooks。

第二阶段：

- 当 Futu / Longbridge 页面稳定后，再抽出 `PlatformWorkbenchView` 减少重复。

原因：

- 当前改动涉及交易链路，先复制再抽象更稳。
- 避免一次性重构 Futu 工作台，减少回归风险。

### 9. 数据和持久化隔离

Longbridge 必须有独立持久化：

- `api/longbridge/longbridgePersistence.ts`
- 独立 SQLite 表或独立表前缀：
  - `longbridge_live_events`
  - `longbridge_pending_orders`
  - `longbridge_submitted_orders`
  - `longbridge_rejected_orders`
  - `longbridge_candidate_pool`
  - `longbridge_skipped`

不能复用 Futu 的：

- `live_events`
- `pending_orders`
- `submitted_orders`
- `candidate_pool`

原因：

- 避免 Futu 与 Longbridge 待确认订单互相污染。
- 后续审计时能明确订单来源平台。

### 10. Source Status 类型扩展

当前 `SourceStatusResponse` 是 Futu 专用：

- `futuOpenDAvailable`
- `futuPythonSdkAvailable`
- `futuOpenDLoggedIn`

建议新增类型，而不是硬塞字段：

- `LongbridgeSourceStatusResponse`

字段建议：

```ts
type LongbridgeSourceStatusResponse = {
  longbridgeCliAvailable: boolean
  longbridgeCliVersion: string
  longbridgeAuthStatus: 'authenticated' | 'not_authenticated' | 'unknown'
  longbridgeSkillsInstalled: boolean
  installedSkills: string[]
  marketDataAvailable: boolean
  accountDataAvailable: boolean
  tradingAvailable: boolean
  mcpFallbackConfigured: boolean
  lastCheckedAt: string
  missingCapabilities: string[]
}
```

前端 Longbridge 数据源面板展示这些字段。

## Assumptions & Decisions

- 已确认：Longbridge 工作台目标是“能够在长桥进行量化交易”，不是继续展示 Skill 清单。
- 已确认：Longbridge 页面内容应与 Futu 工作台一致，但不包含模拟盘。
- 已确认：传给大模型的 Longbridge 行情订阅、K 线、持仓等真实数据，必须来自 Longbridge Skill / CLI / MCP 支持的数据接口。
- 决策：Futu 与 Longbridge 平台隔离，各自使用独立 API namespace、服务、持久化和订单队列。
- 决策：Longbridge 第一阶段使用 CLI 作为主执行通道，MCP 作为 fallback 设计，不在初版强制依赖 MCP。
- 决策：Longbridge 账户/订单能力必须等待 OAuth 授权后才显示为可用。
- 决策：Longbridge mutating 操作必须强制人工确认；不能因为 skill 已装载而自动开放下单。
- 决策：初版不实现 Longbridge 模拟盘。
- 决策：初版先复制 Futu 工作台布局实现 Longbridge 页面，暂不抽象通用平台工作台组件，降低对 Futu 的回归风险。

## Execution Plan

### Phase 1：设计与类型补齐

1. 新增 `LongbridgeSourceStatusResponse`、Longbridge dashboard/trading 相关类型。
2. 新增 `longbridge_skills_reference.md` 的平台化说明补充，如果当前文档不足则更新。
3. 设计 Longbridge CLI 输出解析 schema。

### Phase 2：后端 Longbridge 数据层

1. 新增 `api/longbridge/longbridgeCli.ts`。
2. 新增 `api/longbridge/longbridgeSourceStatusService.ts`。
3. 新增 `api/longbridge/longbridgeAccountService.ts`。
4. 新增 `api/longbridge/longbridgeMarketDataService.ts`。
5. 新增 `api/routes/longbridgeRoutes.ts` 并挂载到 `api/app.ts`。

### Phase 3：Longbridge 工作台 UI

1. 新增 `src/pages/LongbridgeWorkbenchView.tsx`。
2. 替换 `/longbridge` 路由指向新工作台。
3. 复用 Futu 工作台组件：
   - `AccountSummaryPanel`
   - `PositionsPanel`
   - `RiskExposurePanel`
   - `OpportunityCommandPanel`
   - `ResearchReportPanel`
   - `WatchlistPanel`
   - `StatusTimeline`
4. 不渲染 `SimulationTradingPanel`。
5. 新增 Longbridge 数据源状态面板。
6. 新增 Longbridge 实盘量化入口面板。

### Phase 4：Longbridge 实盘量化引擎

1. 新增 Longbridge 独立 trading engine。
2. 新增 Longbridge 独立 order queue 和 persistence。
3. 将 Longbridge 行情、K 线、盘口、持仓传入 LLM prompt。
4. 新增 Longbridge live prompt pack。
5. 接入候选池组合裁决。
6. 生成 Longbridge 待确认订单队列。

### Phase 5：真实订单提交门禁

1. 仅在 OAuth 已授权、Trade permission 可用、环境变量门禁开启时允许确认提交。
2. 下单前先展示 preview。
3. 用户确认后调用 Longbridge order 命令。
4. 提交结果写入 Longbridge 独立 submitted_orders。
5. 失败原因必须写入订单记录。

## Verification Steps

### 静态验证

- `PATH="$PWD/.tools/node/bin:$PATH" npm run check`
- 检查 `/longbridge` 不再展示 Skill 清单页，而是 Longbridge 工作台。
- 检查 `/futu` 不受影响。

### 数据源验证

- 未登录时：
  - `/api/longbridge/source/status` 返回 CLI 可用、auth 未登录、账户不可用。
  - 页面显示账户/持仓不可用，但行情公共能力可用或可尝试。
- 登录后：
  - `.tools/longbridge/longbridge auth status` 显示已登录。
  - `longbridge quote AAPL.US` 可返回真实行情。
  - `/api/longbridge/realtime/AAPL.US` 返回标准化行情。
  - `/api/longbridge/account/dashboard` 返回真实账户/持仓。

### LLM 输入验证

- 在 Longbridge `run-once` 日志中确认传给 LLM 的 `marketData.source` 是 Longbridge。
- 确认 prompt 中不出现 Futu REAL、Futu OpenD、Futu 最大购买力等平台错误文案。
- 确认持仓、购买力、K 线、盘口数据来自 Longbridge CLI/MCP 输出。

### 交易安全验证

- 未开启 Longbridge 实盘门禁时，确认接口不能提交订单。
- 未 OAuth Trade permission 时，确认接口不能提交订单。
- 待确认订单必须需要用户确认。
- Longbridge 订单只写 Longbridge persistence，不写 Futu `pending_orders` / `submitted_orders`。

### 回归验证

- `/futu` 工作台账户、持仓、实盘入口仍正常。
- `/live-trading` Futu 实盘队列不受 Longbridge 数据影响。
- `/simulation` 仍只属于 Futu 平台。
- `/` 平台选择页仍可进入 Futu 和 Longbridge。
