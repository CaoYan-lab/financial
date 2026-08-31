# 长桥实盘行情、K 线与大模型决策测试计划

## Summary

目标是在不提交真实订单的前提下，构建一套可重复执行的 Longbridge 实盘测试用例，覆盖：

- Longbridge CLI 登录态、账户资产、持仓读取。
- Longbridge 真实行情、K 线、盘口/成交数据读取与标准化。
- 长桥实盘大模型决策 dry-run。
- 已开启组合策略时，候选池组合裁决链路是否正确工作。
- 订单确认接口的真实提交门禁是否能拦截，确保测试不会误下单。

用户已确认测试边界为“含订单门禁”：允许真实行情/K 线和真实 LLM 调用，允许写入长桥独立测试信号、候选、待确认订单；真实订单确认接口只验证门禁拦截，不提交订单。

## Current State Analysis

### 1. Longbridge CLI 与 Skill 状态

已安装并可用：

- CLI：`.tools/longbridge/longbridge`
- Auth HOME：`.tools/longbridge-home`
- 已装载 13 个 Longbridge skills。
- 现有 `api/longbridge/longbridgeCli.ts` 会优先使用项目本地 `.tools/longbridge-home`，因此后端能读取本次 OAuth 登录态。

Longbridge skill 文档确认：

- `quote`：真实报价，支持 `--format json`。
- `kline`：K 线，支持 `--period 1m/day/... --count ... --format json`。
- `depth`、`trades`、`intraday`：可用于盘口、成交与分时。
- `assets`、`positions`：账户与持仓。

### 2. 当前 Longbridge 后端能力

文件：

- `api/routes/longbridgeRoutes.ts`
- `api/longbridge/longbridgeAdapter.ts`
- `api/longbridge/longbridgeCli.ts`

当前已有接口：

- `GET /api/longbridge/source/status`
- `GET /api/longbridge/workbench/dashboard`
- `GET /api/longbridge/live-trading/config`
- `PUT /api/longbridge/live-trading/llm-config`
- `PUT /api/longbridge/live-trading/trade-strategy-config`

当前缺口：

- 没有 Longbridge 行情标准化接口，例如 `/api/longbridge/realtime/:symbol`。
- 没有 Longbridge K 线/盘口/成交适配器。
- 没有 Longbridge 独立 run-once 决策引擎。
- 没有 Longbridge 独立 signals / candidate_pool / pending_orders persistence。
- `/longbridge/live-trading` 页面目前展示结构已经接近 Futu，但待确认订单、历史信号、候选池仍是占位数据。

### 3. Futu 实盘链路参考

Futu 实盘真实链路由以下模块组成：

- `api/live/liveTradingEngine.ts`
- `api/live/liveTradingDecisionService.ts`
- `api/live/livePortfolioReviewDecisionService.ts`
- `api/live/liveCandidatePoolService.ts`
- `api/live/liveOrderQueueService.ts`
- `api/live/livePersistence.ts`
- `api/simulation/realtimeDataAdapter.ts`
- `api/simulation/trendContextService.ts`
- `trade_strategy/prompt_packs/llm_autonomous_stock_trader_live_safe_v1.yaml`
- `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`

Longbridge 测试不能直接复用 Futu API、Futu realtimeStore、Futu persistence 表或 Futu 下单服务。可以复用共享的类型、Prompt YAML、LLM 调用工具、解析工具和组合裁决规则，但数据源必须来自 Longbridge CLI/Skill/MCP。

### 4. 测试安全边界

本轮测试允许：

- 真实调用 Longbridge CLI 读取行情/K 线/账户。
- 真实调用大模型生成交易决策。
- 写入 Longbridge 独立测试库中的信号、候选池、待确认订单。
- 调用订单确认接口验证门禁拦截。

本轮测试禁止：

- 调用 Longbridge 真实 order mutation。
- 复用 Futu `pending_orders`、`submitted_orders`、`candidate_pool` 表。
- 将 Longbridge 待确认订单写入 Futu 实盘队列。
- 为了测试临时修改 `trade_strategy` YAML 内容。

## Proposed Changes

### 1. 新增长桥行情数据适配器

新增文件：

- `api/longbridge/longbridgeMarketDataService.ts`

职责：

- 调用 `runLongbridgeCli()` 获取：
  - `quote SYMBOL --format json`
  - `kline SYMBOL --period 1m --count 120 --format json`
  - `depth SYMBOL --format json`
  - `trades SYMBOL --format json`
  - `intraday SYMBOL --format json`
- 标准化为接近 Futu `StrategyMarketData` 的结构：
  - `ticker`
  - `lastPrice`
  - `bars`
  - `tickerPoints`
  - `asks`
  - `bids`
  - `bestAsk`
  - `bestBid`
  - `marketState`
  - `updatedAt`
  - `source: 'longbridge-cli'`

新增测试重点：

- JSON 数组/对象结构兼容解析。
- 缺盘口或缺成交时仍返回可用 quote + kline，并写入 warnings。
- symbol 格式统一使用 Longbridge `<CODE>.<MARKET>`，同时支持从项目票池 ticker 转换：
  - `AAPL` -> `AAPL.US`
  - `NVDA` -> `NVDA.US`
  - `07709` -> `7709.HK` 或按 CLI 实测可用格式保留。

### 2. 新增长桥账户适配补充

更新文件：

- `api/longbridge/longbridgeAdapter.ts`

补充职责：

- 将现有 `assets`、`positions` 输出标准化为 LLM 可用账户结构。
- 输出字段应包含：
  - 总资产 USD
  - 现金 USD
  - 最大购买力 USD
  - 持仓列表
  - 风险等级
  - `source: 'longbridge-cli'`

测试重点：

- 当前账户 `assets` 数组返回结构能够解析。
- 空持仓 `positions: []` 被识别为“已授权但空仓”，不是“未授权”。
- 未授权时返回明确错误，不生成决策。

### 3. 新增长桥实盘决策 dry-run 服务

新增文件：

- `api/longbridge/longbridgeLiveDecisionService.ts`

职责：

- 使用 `trade_strategy` 中当前 live Prompt：
  - `llm_autonomous_stock_trader_live_safe_v1`
- 构建 Longbridge 版本 Prompt 输入：
  - 账户、持仓、购买力来自 Longbridge。
  - quote、K 线、盘口、成交来自 Longbridge。
  - Prompt YAML 不复制、不臆造；只复用当前 active prompt pack。
  - 平台说明字段明确为 Longbridge，避免 Prompt 中出现 Futu REAL、Futu OpenD、Futu 最大购买力等错误文案。
- 调用现有 `callArkResponses()`。
- 复用 `parseLiveTradingDecision()` 或抽出共享解析函数，校验返回 JSON：
  - `HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE`
  - ticker 必须一致。
  - orderQuantity 非负整数。
  - SELL_SHORT 必须有风险说明。

测试重点：

- Prompt payload 中 `marketData.source` 为 `longbridge-cli`。
- Prompt payload 含 quote、K 线、盘口、账户和持仓。
- Prompt payload 不含 Futu 平台语义。
- 真实 LLM 返回可解析 JSON。

### 4. 新增长桥组合策略 dry-run 服务

新增文件：

- `api/longbridge/longbridgeCandidatePoolService.ts`
- `api/longbridge/longbridgeOrderQueueService.ts`
- `api/longbridge/longbridgePersistence.ts`
- `api/longbridge/longbridgeLiveTradingEngine.ts`

职责：

- `runOnceDryRun()`：
  1. 读取 Longbridge 账户。
  2. 拉取测试 symbol 的真实行情/K 线/盘口。
  3. 调用 Longbridge LLM 决策。
  4. 如果返回 `HOLD`，写入 Longbridge signal history。
  5. 如果返回非 HOLD 且组合策略开启，写入 Longbridge candidate pool。
  6. 调用现有组合裁决服务，但输入数据和 pendingOrders 来自 Longbridge 独立队列。
  7. 被推进的候选进入 Longbridge 待确认订单队列。
  8. 不提交真实订单。

独立持久化表建议：

- `longbridge_live_signals`
- `longbridge_candidate_pool`
- `longbridge_pending_orders`
- `longbridge_submitted_orders`
- `longbridge_rejected_orders`
- `longbridge_skipped`

测试重点：

- 开启组合策略后，非 HOLD 信号先进入候选池。
- 组合裁决 Prompt YAML 来自 `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`。
- DeepSeek 时间预设使用当前 runtime selection。
- pendingOrders 不能作为唯一 suppress 理由。
- 推进候选只进入 Longbridge 待确认队列。

### 5. 新增长桥 API 测试端点

更新文件：

- `api/routes/longbridgeRoutes.ts`

新增接口：

- `GET /api/longbridge/realtime/:symbol`
  - 返回标准化 Longbridge 行情、K 线、盘口和成交。
- `POST /api/longbridge/live-trading/run-once`
  - 执行 Longbridge dry-run 决策。
  - 默认不提交真实订单。
- `GET /api/longbridge/live-trading/dashboard`
  - 返回 Longbridge 独立 signals、candidate pool、pending orders。
- `POST /api/longbridge/live-trading/pending-orders/:id/confirm`
  - 本阶段只验证门禁。
  - 若 `LONGBRIDGE_LIVE_TRADING_ENABLED !== 'true'`，必须返回 403。
  - 即使门禁开启，若没有显式实现真实 order adapter，也必须返回 501 或 403，不得调用 CLI order。

### 6. 新增测试用例

新增测试文件：

- `tests/longbridgeMarketData.integration.test.ts`
- `tests/longbridgeLiveDecision.integration.test.ts`
- `tests/longbridgeLiveTradingDryRun.test.ts`

#### 6.1 行情/K 线集成测试

执行条件：

- `RUN_LONGBRIDGE_INTEGRATION=1`
- Longbridge CLI 可用。

测试 symbols：

- `AAPL.US`
- `NVDA.US`
- `700.HK`

用例：

1. `quote` 返回最新价、昨收、成交量或交易状态。
2. `kline --period 1m --count 30` 返回至少 1 根 bar。
3. `kline --period day --count 20` 返回日 K。
4. 标准化后的 `StrategyMarketData` 包含 `lastPrice`、`bars`、`updatedAt`。
5. 不可用 symbol 返回明确错误，不抛未捕获异常。

#### 6.2 大模型决策集成测试

执行条件：

- `RUN_LONGBRIDGE_LLM_INTEGRATION=1`
- `ARK_API_KEY` 或 `DEEPSEEK_API_KEY` 可用。
- `RUN_LONGBRIDGE_INTEGRATION=1`

用例：

1. 使用 `AAPL.US` 真实 quote + 1m K 线构建 Prompt。
2. 断言 Prompt 中数据源为 Longbridge。
3. 调用真实 LLM。
4. 断言返回 JSON 可解析。
5. 断言 ticker 一致。
6. 断言非 HOLD 时必须有正整数 quantity、limitPrice 和风险说明。
7. 不写真实订单。

#### 6.3 组合策略 dry-run 测试

执行条件：

- `RUN_LONGBRIDGE_DRY_RUN=1`
- 使用临时 DB：
  - `LONGBRIDGE_LIVE_HISTORY_DB_PATH=/tmp/financial-longbridge-live-test-<pid>.sqlite3`

用例：

1. 将 live executionMode 设置为 `candidate_pool`。
2. 执行 `longbridgeLiveTradingEngine.runOnceDryRun('AAPL.US')`。
3. 若 LLM 返回 HOLD：
   - 写入 signal history。
   - 不生成 candidate。
   - 用例通过，但标记为 HOLD 分支。
4. 若 LLM 返回 BUY / SELL_SHORT / SELL_TO_CLOSE：
   - 写入 candidate_pool。
   - 调用组合裁决。
   - 若组合裁决 promoted，生成 Longbridge pending order。
   - pending order 必须是 Longbridge 独立队列。
5. 断言 Futu `livePersistence` 未新增订单。

#### 6.4 订单门禁测试

执行条件：

- `RUN_LONGBRIDGE_DRY_RUN=1`

用例：

1. 构造一个 Longbridge pending order。
2. 调用 `POST /api/longbridge/live-trading/pending-orders/:id/confirm`。
3. 当 `LONGBRIDGE_LIVE_TRADING_ENABLED` 未开启时，返回 403。
4. 断言没有执行任何 `longbridge order` CLI 命令。
5. 断言 pending order 状态仍可审计，失败原因明确。

### 7. 手动冒烟测试脚本

新增脚本：

- `scripts/longbridge-live-smoke.ts`

命令：

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 node --import tsx scripts/longbridge-live-smoke.ts AAPL.US
```

输出：

- CLI auth status。
- assets 摘要。
- quote 摘要。
- 1m K 线数量。
- prompt 数据源摘要。
- LLM 决策摘要。
- candidate/pending order dry-run 摘要。
- 门禁确认结果。

脚本默认：

- 不提交真实订单。
- 不开启 `LONGBRIDGE_LIVE_TRADING_ENABLED`。
- 只写 Longbridge 临时测试 DB。

## Assumptions & Decisions

- 已确认测试边界：含订单门禁，但不提交真实订单。
- Longbridge 数据源必须来自 Longbridge CLI/Skill/MCP，不使用 Futu realtimeStore。
- Longbridge 测试可以复用共享 LLM 调用与 JSON 解析工具。
- Longbridge 测试可以复用 `trade_strategy` YAML，但不能复制或改写 YAML。
- Longbridge 持久化必须独立，不能写 Futu 表。
- 测试默认 symbol 使用 `AAPL.US`，补充 `NVDA.US` 和 `700.HK` 覆盖美股与港股。
- 如果真实 LLM 返回 HOLD，dry-run 用例不强行失败；只要信号、Prompt、数据源和安全边界正确即可。

## Verification Steps

### 静态检查

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm run check
```

### 常规单测

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm test
```

### Longbridge 行情/K 线集成测试

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 npm test -- tests/longbridgeMarketData.integration.test.ts
```

验收：

- `AAPL.US` quote 成功。
- `AAPL.US` 1m K 线有数据。
- `700.HK` quote 或 market closed 状态能被结构化返回。

### Longbridge 大模型 dry-run

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 npm test -- tests/longbridgeLiveDecision.integration.test.ts
```

验收：

- Prompt 使用 Longbridge 数据源。
- LLM 返回 JSON 可解析。
- 不生成真实订单。

### Longbridge 组合策略 dry-run

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 RUN_LONGBRIDGE_DRY_RUN=1 npm test -- tests/longbridgeLiveTradingDryRun.test.ts
```

验收：

- 组合策略开启时，非 HOLD 信号进入 Longbridge candidate pool。
- promoted 候选进入 Longbridge pending order。
- Futu pending order / candidate pool 不受影响。

### 订单门禁验证

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_DRY_RUN=1 npm test -- tests/longbridgeLiveTradingDryRun.test.ts -t 门禁
```

验收：

- confirm 接口返回 403 或安全阻断。
- 没有调用 `longbridge order`。
- 没有 submitted order。

