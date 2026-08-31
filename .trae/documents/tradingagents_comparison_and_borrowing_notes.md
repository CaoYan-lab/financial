# TradingAgents 与本项目 Futu / Longbridge / Futu A 股对比分析

## 结论摘要

`TauricResearch/TradingAgents` 是一个研究型多 Agent 金融分析框架，核心价值不在券商接入或实盘下单，而在“多角色研究流水线 + 结构化辩论 + 风险复核 + 记忆反思 + checkpoint 恢复”。它适合借鉴为本项目的“决策质量增强层”，不适合直接替换当前 Futu、Longbridge、Futu A 股的实盘引擎。

本项目当前优势是实盘工程链路更完整：

- 已接入真实行情订阅、账户、订单队列、自动下单开关和平台隔离。
- Futu / Longbridge 已有 `legacy_direct` 与 `candidate_pool` 两种 executionMode。
- 已有 120 根 1m K 线、tickerPoints、盘口、市场时段 Gate、持久化历史和待确认订单。
- A 股模块已独立目录、独立配置、独立持久化，正在追齐老逻辑。

TradingAgents 值得借鉴的是：

- 把一次 LLM 决策拆成可审计的多阶段报告，而不是只让单个 Prompt 直接给 BUY / HOLD / SELL。
- 引入 Bull / Bear 研究辩论和 Aggressive / Neutral / Conservative 风险辩论。
- 引入 per-symbol 决策记忆，把历史决策的收益反馈注入下一次 Prompt。
- 引入 checkpoint/resume，避免长链路 LLM 中断后重跑全部节点。
- 引入统一 provider registry / model catalog / data vendor contract，让模型和数据源选择更可控。

优先建议：不要照搬 LangGraph/Python 全框架；应在现有 Node/TS 实盘链路里增量实现“轻量多 Agent 决策包”。

## TradingAgents 核心结构

来源：`https://github.com/TauricResearch/TradingAgents`

主要模块：

- `tradingagents/graph/trading_graph.py`
  - 核心编排类 `TradingAgentsGraph`
  - 使用 LangGraph 组织多节点流程
  - 支持 `.propagate(ticker, trade_date)` 返回最终决策
  - 支持 checkpoint resume
  - 支持决策日志与历史反馈
- `tradingagents/agents/analysts/`
  - `market_analyst.py`
  - `sentiment_analyst.py`
  - `news_analyst.py`
  - `fundamentals_analyst.py`
- `tradingagents/agents/researchers/`
  - `bull_researcher.py`
  - `bear_researcher.py`
- `tradingagents/agents/risk_mgmt/`
  - `aggressive_debator.py`
  - `neutral_debator.py`
  - `conservative_debator.py`
- `tradingagents/agents/managers/`
  - `research_manager.py`
  - `portfolio_manager.py`
- `tradingagents/agents/utils/agent_states.py`
  - 定义完整 AgentState，包括 market report、sentiment report、news report、fundamentals report、investment debate、risk debate、final decision。
- `tradingagents/default_config.py`
  - 配置 quick/deep 模型、provider、debate rounds、data vendors、temperature 等。
- `tradingagents/llm_clients/`
  - provider registry / model catalog / OpenAI-compatible / Anthropic / Google / Bedrock 等。
- `tradingagents/dataflows/`
  - yfinance、Alpha Vantage、FRED、Polymarket、Reddit、StockTwits、symbol normalization、market data validator。

TradingAgents 的标准链路：

1. 解析 ticker identity 和 benchmark。
2. Market / sentiment / news / fundamentals analyst 分别产出报告。
3. Bull 与 Bear researcher 围绕报告做投资辩论。
4. Research Manager 汇总研究侧结论。
5. Trader Agent 形成交易计划。
6. Aggressive / Neutral / Conservative 风险角色进行风险辩论。
7. Portfolio Manager 做最终裁决。
8. 写入报告、决策日志和 memory。
9. 下一次同 ticker 运行时，读取历史决策收益反馈和反思。

## 当前项目三条实盘链路

### Futu 美港股

关键路径：

- `api/live/liveTradingEngine.ts`
- `api/live/liveTradingDecisionService.ts`
- `api/live/liveCandidatePoolService.ts`
- `api/live/livePortfolioReviewDecisionService.ts`
- `api/live/liveOrderQueueService.ts`
- `api/live/livePersistence.ts`
- `src/pages/LiveTradingView.tsx`
- `src/components/trading/TradeStrategyConfigPanel.tsx`

当前特点：

- 使用真实 Futu 行情和账户。
- 评估前做市场时段 Gate。
- 使用 `loadStrategyMarketData()` 获取 1m K 线、tickerPoints、盘口和趋势上下文。
- 支持 LLM 并发和 pacing。
- `legacy_direct`：单票 LLM 决策通过风控后直接进入待确认订单。
- `candidate_pool`：非 HOLD 先进入候选池，再由组合裁决 Prompt 推进。
- 支持自动下单开关，但仍受 `LIVE_TRADING_ENABLED` 和真实账户环境门禁约束。
- 历史信号、待确认订单、候选池均持久化。

### Longbridge 美港股

关键路径：

- `api/longbridge/longbridgeLiveTradingEngine.ts`
- `api/longbridge/longbridgeRealtimeSubscriptionService.ts`
- `api/longbridge/longbridgeRealtimeDataAdapter.ts`
- `api/longbridge/longbridgeCandidatePoolService.ts`
- `api/longbridge/longbridgeOrderQueueService.ts`
- `api/longbridge/longbridgePersistence.ts`
- `src/pages/longbridge/LongbridgeLiveTradingView.tsx`

当前特点：

- 接入 Longbridge 行情、账户和订单。
- 有独立实时订阅与 K 线补齐逻辑。
- 因 CLI/API 限流，当前强调串行和 pacing。
- 与 Futu 共享 `tradeStrategyConfigService` 的 live 策略配置语义。
- 支持 `legacy_direct` 与 `candidate_pool`。
- 支持候选池定时 review。
- 支持自动提交开关。

### Futu A 股

关键路径：

- `api/ashare/aShareLiveTradingEngine.ts`
- `api/ashare/aShareRuntimeConfigService.ts`
- `api/ashare/aShareRealtimeSubscriptionService.ts`
- `api/ashare/aShareRealtimeStore.ts`
- `api/ashare/aShareCandidatePoolService.ts`
- `api/ashare/aShareOrderQueueService.ts`
- `api/ashare/aSharePersistence.ts`
- `api/ashare/aShareMarketSessionGate.ts`
- `src/pages/ashare/AshareLiveTradingView.tsx`
- `src/hooks/ashare/useAshareWorkbench.ts`

当前特点：

- A 股已做目录隔离和持久化隔离。
- 使用独立 `.data/a-share-live-history.sqlite3` 和 `.data/a-share-live-config.json`。
- 使用 A 股交易时段 Gate。
- 禁止 `SELL_SHORT`。
- 支持 A 股独立 LLM 配置、并发配置、策略配置 namespace。
- 支持 `legacy_direct` 与 `candidate_pool`。
- 仍处于追齐老逻辑阶段，真实账户、真实组合持仓上下文、清理 mock 数据等还需要继续完善。

## 维度对比

| 维度 | TradingAgents | Futu 美港股 | Longbridge | Futu A 股 |
|---|---|---|---|---|
| 定位 | 研究型多 Agent 框架 | 实盘交易执行链路 | 实盘交易执行链路 | 新增 A 股实盘链路 |
| 券商接入 | 无真实下单，模拟/研究为主 | Futu 实盘 | Longbridge 实盘 | Futu A 股规划中 |
| 决策结构 | 多 analyst + debate + manager | 单票 LLM + 候选池组合裁决 | 单票 LLM + 候选池组合裁决 | 单票 LLM + 候选池组合裁决 |
| 数据源 | Yahoo/Alpha Vantage/FRED/Reddit/StockTwits/Polymarket | Futu 实时行情、账户、订单 | Longbridge 实时行情、账户、订单 | Futu A 股行情 |
| 时间粒度 | 偏日线/研究日期 | 1m K线 + tickerPoints + 盘口 | 1m K线 + trades/depth | 1m K线 + tickerPoints + 盘口 |
| 组合裁决 | Portfolio Manager 最终决策 | candidate_pool DeepSeek 裁决 | candidate_pool DeepSeek 裁决 | candidate_pool DeepSeek 裁决 |
| 风险辩论 | Aggressive / Neutral / Conservative 多角色 | 后端硬风控 + Prompt 风控 | 后端硬风控 + Prompt 风控 | A 股硬风控起步 |
| 记忆机制 | 决策日志 + 实现收益反思 | 历史信号/订单持久化，但未做收益反思注入 | 历史信号/订单持久化，但未做收益反思注入 | 独立持久化，未做收益反思注入 |
| Checkpoint | LangGraph SQLite checkpoint | 无 LLM 节点级 resume | 无 LLM 节点级 resume | 无 LLM 节点级 resume |
| 多模型能力 | provider registry + quick/deep 模型 | Ark/DeepSeek 类模型配置 | 共享模型配置 | 独立 A 股模型配置 |
| UI | CLI 进度为主 | 完整 Web 工作台 | 完整 Web 工作台 | Web 工作台追齐中 |

## 可借鉴点

### 1. 多角色研究包，而不是单 Prompt 直出交易

TradingAgents 将决策拆成：

- Market Analyst
- Sentiment Analyst
- News Analyst
- Fundamentals Analyst
- Bull Researcher
- Bear Researcher
- Trader
- Risk Debaters
- Portfolio Manager

本项目当前的单票 LLM 请求更偏“即时交易判断”。优势是快，适合实盘；弱点是解释结构和反方审查不足。

建议借鉴方式：

- 不要每轮实盘都跑完整 TradingAgents 链路，成本和延迟不适合。
- 在 candidate_pool 阶段引入轻量版多角色结构：
  - `technical_report`: 当前 120 根 1m K线、tickerPoints、盘口、趋势上下文。
  - `microstructure_report`: 盘口、成交点、价差、流动性。
  - `position_risk_report`: 账户持仓、候选池重复暴露、同组风险。
  - `bull_case`: 推进理由。
  - `bear_case`: 不推进理由。
  - `risk_judge`: 最终是否进入待确认订单。

落地位置：

- Futu / Longbridge：扩展 `api/live/livePortfolioReviewDecisionService.ts`。
- A 股：复用同一服务，但使用 `ashare` namespace 和 A 股风控上下文。
- YAML：新增或扩展 `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`。

### 2. 决策记忆与收益反思

TradingAgents 的 memory 机制会记录某 ticker 的最终决策，下一次运行时获取实现收益和 alpha，再生成反思注入 Prompt。

本项目已有：

- 历史信号
- 待确认订单
- submitted / rejected
- candidate_pool
- skipped

但缺少：

- 信号后的实现收益。
- 买入后 N 分钟 / N 小时 / 次日表现。
- “上次判断错在哪里”的结构化反思。

建议新增：

- `live_decision_outcomes`
  - `platform`: futu | longbridge | ashare
  - `ticker`
  - `signalId`
  - `decisionMode`
  - `entryReferencePrice`
  - `return_5m`
  - `return_30m`
  - `return_1d`
  - `max_drawdown_30m`
  - `alpha_vs_benchmark`
  - `reflection`
  - `resolvedAt`
- 每轮 LLM 前注入最近同 ticker 的 3 条经验：
  - 哪类信号有效。
  - 哪类噪声导致误判。
  - 当前是否存在重复错误模式。

注意：这应是“评估反馈”，不是自动重试机制。

### 3. Checkpoint / Resume

TradingAgents 支持 LangGraph checkpoint，长链路中断后从上一个节点恢复。

本项目当前实盘链路是批量 ticker evaluation。若中途 LLM 失败或服务重启，通常只能等下一轮或重跑。

建议：

- 不需要引入 LangGraph。
- 可以实现轻量 `evaluation_run_steps`：
  - `runId`
  - `platform`
  - `ticker`
  - `step`: market_data_ready | single_llm_done | signal_persisted | candidate_upserted | portfolio_review_done | pending_order_created
  - `status`: pending | done | failed | skipped
  - `payload`
  - `updatedAt`
- `runOnce()` 开始前创建 runId。
- 每个 ticker 每个阶段持久化 checkpoint。
- 服务重启后 UI 显示“上一轮中断位置”，允许人工触发 resume 或 discard。

优先用于：

- Longbridge，因为 CLI/API 限流，重跑代价高。
- A 股，因为新模块还在补全，调试中断概率高。

### 4. Provider Registry / Model Catalog

TradingAgents 将 LLM provider、model、capability、thinking effort、temperature 等统一管理。

本项目当前：

- Futu / Longbridge 共享 `llmRuntimeConfigService`。
- A 股有独立 `aShareRuntimeConfigService`。
- `callArkResponses` 已支持传入 model override。

可借鉴：

- 建立统一 `api/llm/modelCatalog.ts`：
  - provider
  - modelId
  - label
  - supportsStructuredOutput
  - supportsReasoningEffort
  - defaultTimeoutMs
  - recommendedUse: single_signal | portfolio_review | reflection
- UI 上不要只是模型列表，应区分：
  - 单票快速判断模型。
  - 组合裁决深度模型。
  - 反思/复盘模型。

这能减少“所有任务都用同一个模型”的问题。

### 5. Data Vendor Contract

TradingAgents 的 `data_vendors` 和 `tool_vendors` 让每类数据源有清晰路由。

本项目当前数据源按平台硬编码：

- Futu：Futu quote/ticker/kline/orderbook。
- Longbridge：Longbridge quote/kline/depth/trades。
- A 股：Futu A 股订阅。

可借鉴：

- 定义 `MarketDataCapabilityContract`：
  - `supportsQuote`
  - `supportsTickerPoints`
  - `supportsOrderBook`
  - `supportsKline1m`
  - `supportsExtendedHours`
  - `supportsAshareRth`
  - `freshnessMaxAgeMs`
  - `fallbackAllowed`
- 每个平台 dashboard 显示 capability 状态。
- LLM prompt 明确哪些字段是实时、哪些是 fallback、哪些缺失。

这对 A 股尤其重要，因为未来 Futu A 股行情权限、逐笔成交、盘口档位可能存在权限差异。

### 6. Structured Output 与 Schema Gate

TradingAgents 近版本强调 structured-output agents，并有测试覆盖。

本项目已有 JSON parse，但仍可强化：

- 单票 LLM 决策 schema。
- 组合裁决 schema。
- 风控补充字段 schema。
- 失败时不要只记录 `parse failed`，应记录缺哪个 key、类型是否错、原始 text hash。

建议：

- 将 `requiredJson` 从 YAML 进一步变成运行时校验 schema。
- 对 `BUY / SELL_TO_CLOSE / SELL_SHORT` 做平台级枚举约束。
- A 股 schema 直接移除 `SELL_SHORT`，而不是只靠 prompt 禁止。

### 7. 报告树 / 审计包

TradingAgents 会输出 report tree。它不是交易执行必须项，但非常适合本项目的事后审计。

建议新增：

- 每次组合裁决生成一个 `decision audit pack`：
  - 单票信号摘要。
  - 候选池排序。
  - 组合裁决原因。
  - 风控拒绝原因。
  - 最终 pending order 列表。
  - 该轮未推进候选原因。

落地：

- SQLite 存摘要。
- Markdown 写入 `.data/audit-packs/<platform>/<runId>.md`。
- 前端订单详情页显示该 runId 的审计包。

## 不建议照搬的部分

### 1. 不建议把实盘 runOnce 改成完整 LangGraph

原因：

- 当前实盘需要低延迟、强 Gate、强持久化、强人工确认。
- LangGraph 引入 Python runtime、节点状态、checkpoint 依赖，会显著提高复杂度。
- Futu / Longbridge / A 股已经有不同券商状态和限速约束，直接套 TradingAgents 的 research graph 会破坏现有边界。

更合适方式：

- 在组合裁决或复盘阶段引入多 Agent 思想。
- 实盘下单链路仍保留 Node/TS 当前结构。

### 2. 不建议直接引入 Yahoo Finance 作为实盘价格源

TradingAgents 的 yfinance/Alpha Vantage 适合研究，不适合本项目实盘触发。

本项目应该坚持：

- 实盘价格以 Futu / Longbridge 订阅为准。
- 外部数据只能作为辅助上下文，不得替代实时 quote/ticker/orderbook。
- 外部新闻/基本面数据需要标记数据时间，避免 lookahead 或滞后污染。

### 3. 不建议每个股票每轮都跑多角色辩论

原因：

- 当前股票池 20 左右，并且可能高频扫描。
- 多角色链路 LLM 成本和延迟很高。
- 会加重限流问题，尤其 Longbridge 已经需要串行 pacing。

更合适方式：

- 单票阶段保持轻量。
- 候选池阶段只对候选集合做多角色裁决。
- 盘后复盘阶段再跑完整多 Agent 解释。

## 推荐落地路线

### P0：补齐 A 股与老逻辑一致性

状态：正在进行。

目标：

- A 股页面、后台、配置、持久化继续追齐 Futu / Longbridge。
- 清理 mock 数据前提供明确脚本或按钮。
- A 股候选池裁决应接入真实持仓上下文，而不是空账户。

不建议此阶段引入 TradingAgents 复杂机制，避免边界继续扩大。

### P1：组合裁决 Prompt 升级为“轻量多 Agent 裁决包”

目标：

- 保持现有 `candidate_pool` 入口不变。
- 扩展组合裁决输出：
  - `technicalSummary`
  - `bullCase`
  - `bearCase`
  - `riskCase`
  - `portfolioDecision`
  - `whyPromoteNow`
  - `whyNotOthers`
- UI 在候选池模块展示这些字段。

涉及文件：

- `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`
- `api/live/livePortfolioReviewDecisionService.ts`
- `api/live/liveCandidatePoolService.ts`
- `api/longbridge/longbridgeCandidatePoolService.ts`
- `api/ashare/aShareCandidatePoolService.ts`
- `src/pages/LiveTradingView.tsx`
- `src/pages/longbridge/LongbridgeLiveTradingView.tsx`
- `src/pages/ashare/AshareLiveTradingView.tsx`

### P2：决策 outcome 与 reflection

目标：

- 为每个信号补后验收益。
- 生成同 ticker 反思。
- 下一次同 ticker LLM 请求注入最近经验。

涉及文件：

- 新增 `api/live/liveDecisionOutcomeService.ts`
- 新增 `api/longbridge/longbridgeDecisionOutcomeService.ts`
- 新增 `api/ashare/aShareDecisionOutcomeService.ts`
- 扩展各平台 persistence。
- 扩展 prompt context。

### P3：LLM model catalog 分层

目标：

- 拆分“单票模型 / 组合裁决模型 / 复盘模型”。
- 支持 provider capability。
- 支持不同模型 timeout 和 structured output 能力。

涉及文件：

- 新增 `api/llm/modelCatalog.ts`
- 调整 `api/simulation/llmRuntimeConfigService.ts`
- 调整 `api/ashare/aShareRuntimeConfigService.ts`
- 调整各平台配置 UI。

### P4：轻量 checkpoint/resume

目标：

- 为长桥和 A 股先做 per-run step checkpoint。
- UI 展示中断轮次。
- 支持人工 discard / resume。

涉及文件：

- 新增 `api/live/evaluationCheckpointService.ts`
- 三个平台引擎分阶段写 checkpoint。
- 前端 dashboard 显示 checkpoint 状态。

## 对三条平台的具体建议

### Futu 美港股

优先借鉴：

- 多角色组合裁决。
- 后验收益 reflection。
- 审计包。

原因：

- Futu 当前链路最完整，适合作为能力验证主平台。
- 已有候选池、组合裁决、自动下单门禁和完整 UI。

不优先：

- 引入 checkpoint。

原因：

- 当前 Futu 数据源与实时订阅比 Longbridge 更顺，checkpoint 价值不如长桥高。

### Longbridge

优先借鉴：

- checkpoint/resume。
- provider/model catalog。
- data capability contract。

原因：

- Longbridge 已有 CLI/API 限流和串行队列，失败重跑成本高。
- 需要更清晰地区分 CLI fallback、SDK 缓存、实时订阅数据的新鲜度。

不优先：

- 每轮多角色研究。

原因：

- 会进一步放大限流和延迟。

### Futu A 股

优先借鉴：

- Data vendor contract。
- A 股专属 schema gate。
- 后验收益 reflection。
- 组合裁决多角色字段。

原因：

- A 股有午休、涨跌停、T+1、禁止卖空、交易单位、价格笼子等独特约束。
- 单纯复用美港股 Prompt 容易遗漏制度差异。

必须避免：

- 用 TradingAgents 的 `.SS/.SZ` Yahoo ticker 规则替代 Futu `SH.` / `SZ.` 实盘代码。
- 用外部日线数据覆盖 Futu A 股实时订阅数据。

## 建议的第一版改造目标

第一版不要大改架构，只做一个最小可验证闭环：

1. 扩展组合裁决 Prompt，让它输出 `bullCase / bearCase / riskCase / finalPortfolioDecision`。
2. 三个平台候选池表格显示这些字段。
3. 不改变现有订单生成逻辑。
4. 不改变实盘下单门禁。
5. 对 A 股强制 schema：禁止 `SELL_SHORT`。
6. 每个组合裁决写入一个审计包。

成功标准：

- 现有 `legacy_direct` 不受影响。
- `candidate_pool` 下的待确认订单仍只来自 promoted candidate。
- UI 能清楚回答：
  - 为什么这个候选被推进？
  - 为什么其他候选没有推进？
  - 风险角色反对点是什么？
  - 当前组合层面的最大风险是什么？

## 最终判断

TradingAgents 对本项目最有价值的不是“多 Agent 框架本身”，而是它把金融决策拆成可解释、可恢复、可复盘的流水线。

本项目不应迁移到 TradingAgents，而应吸收以下设计：

- 多角色裁决结构。
- 决策记忆和收益反思。
- checkpoint/resume。
- provider/model catalog。
- 数据源 capability contract。
- 结构化输出 schema gate。
- 审计报告树。

落地顺序应从 `candidate_pool` 开始，因为它天然就是组合级决策入口，既能提升决策质量，又不会破坏当前实盘下单安全边界。
