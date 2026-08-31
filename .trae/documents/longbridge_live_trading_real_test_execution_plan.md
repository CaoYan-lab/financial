# 长桥实盘行情、K 线与大模型决策实际测试执行计划

## Summary

目标是在 Longbridge 已登录授权、组合策略已开启的前提下，实际验证长桥实盘链路的数据和决策能力：

- 使用 Longbridge CLI 读取真实账户状态、资产、持仓。
- 使用 Longbridge CLI 读取真实 quote、1m K 线、盘口、成交。
- 使用当前项目共用的 live Prompt 与 DeepSeek/Ark 环境配置，真实调用大模型生成交易决策。
- 在组合策略 `candidate_pool` 模式下验证候选池和组合裁决是否工作。
- 验证待确认订单的真实提交门禁，确保测试期间不会提交真实订单。

本计划不实现真实 Longbridge 下单。本轮所有“实盘测试”均限定为真实数据 + 真实 LLM + dry-run 队列 + 门禁拦截。

## Current State Analysis

### 已存在的 Longbridge 测试链路

当前仓库已经具备 Longbridge 独立测试模块：

- `api/longbridge/longbridgeCli.ts`
  - 优先使用 `.tools/longbridge/longbridge`。
  - 授权 HOME 固定到 `.tools/longbridge-home`。
- `api/longbridge/longbridgeAdapter.ts`
  - 已读取 Longbridge source status、资产、持仓。
  - 已兼容 `assets` 返回数组的情况。
- `api/longbridge/longbridgeMarketDataService.ts`
  - `loadLongbridgeStrategyMarketData(symbol, options)` 已拉取 quote、1m K 线、depth、trades，并标准化为 LLM 输入。
  - `normalizeLongbridgeSymbol()` 支持 `AAPL` -> `AAPL.US`、`00700.HK` -> `700.HK`、`07709` -> `7709.HK`。
- `api/longbridge/longbridgeLiveDecisionService.ts`
  - 使用 `getActivePromptPack('live')` 读取共用 live Prompt。
  - 调用现有 `callArkResponses()`。
  - Prompt payload 明确标记 `platform: Longbridge`、`dataSource: Longbridge Skill / CLI / MCP`。
  - 解析并校验 `HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE`。
- `api/longbridge/longbridgeLiveTradingEngine.ts`
  - `runOnceDryRun(symbol)` 串起账户、行情、LLM、信号、候选池、组合裁决、待确认订单。
  - 读取 `getTradeStrategyRuntimeConfig('live').selection.executionMode`，支持当前组合策略模式。
- `api/longbridge/longbridgeCandidatePoolService.ts`
  - 使用共用 `trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml`。
  - 快照中包含原始 YAML、preset、decision rules 等信息。
- `api/longbridge/longbridgeOrderQueueService.ts`
  - `confirmPendingOrder()` 受 `LONGBRIDGE_LIVE_TRADING_ENABLED` 门禁保护。
  - 门禁关闭时返回拦截，不改变为真实提交。
  - 即使门禁开启，当前真实 order adapter 未实现，也会安全阻断。
- `api/routes/longbridgeRoutes.ts`
  - 已有 `GET /api/longbridge/realtime/:symbol`。
  - 已有 `GET /api/longbridge/live-trading/dashboard`。
  - 已有 `POST /api/longbridge/live-trading/run-once`。
  - 已有 `POST /api/longbridge/live-trading/pending-orders/:id/confirm`。

### 已存在的测试文件

- `tests/longbridgeMarketData.integration.test.ts`
  - `RUN_LONGBRIDGE_INTEGRATION=1` 时读取 `AAPL.US` 真实 quote 和 1m K 线。
  - 校验 symbol 标准化。
  - 校验不可用 symbol 返回结构化错误。
- `tests/longbridgeLiveDecision.integration.test.ts`
  - `RUN_LONGBRIDGE_INTEGRATION=1` 时用真实行情构建 Prompt。
  - `RUN_LONGBRIDGE_LLM_INTEGRATION=1` 时真实调用大模型。
- `tests/longbridgeLiveTradingDryRun.test.ts`
  - 常规测试验证订单门禁关闭时不会提交。
  - `RUN_LONGBRIDGE_DRY_RUN=1 RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1` 时跑完整 dry-run。
- `scripts/longbridge-live-smoke.ts`
  - 手工 smoke：读取授权、资产、行情、Prompt 来源、dry-run 决策、门禁结果。

### 当前测试缺口

现有用例已覆盖核心链路，但实际测试时还需要明确执行矩阵：

- 基础只读：不调用 LLM，只验证 CLI、账户、行情、K 线。
- Prompt 构造：真实行情进入 Prompt，但不调用 LLM。
- LLM 决策：真实行情 + 真实账户 + 真实 LLM。
- 组合策略 dry-run：真实行情 + 真实 LLM + candidate pool + portfolio review + pending order。
- 订单门禁：确认接口必须被拦截，不能提交真实订单。

## Proposed Changes

### 1. 不新增真实下单能力

本轮不改造 `longbridgeOrderQueueService.ts` 为真实 order adapter，不添加 Longbridge order mutation 调用。

原因：

- 用户当前目标是测试行情、K 线、大模型决策和组合策略。
- 实盘真实提交需要额外的下单 API 能力、账户权限、风控确认、撤单/状态同步和错误恢复，本轮不纳入。
- 当前门禁已能验证“待确认订单不会误提交”。

### 2. 执行分层测试矩阵

按风险从低到高执行：

1. TypeScript 静态检查
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" npm run check
     ```
   - 成功标准：无 TS 类型错误。

2. 门禁单测
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" npm test -- tests/longbridgeLiveTradingDryRun.test.ts
     ```
   - 成功标准：
     - `Longbridge order gate` 通过。
     - 未设置集成环境变量时，完整 dry-run 集成测试跳过。

3. 行情/K 线真实集成测试
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 npm test -- tests/longbridgeMarketData.integration.test.ts
     ```
   - 成功标准：
     - `AAPL.US` quote 可用。
     - `lastPrice > 0`。
     - 1m K 线非空。
     - source 为 `longbridge-cli`。
     - invalid symbol 返回结构化错误。

4. Prompt 构造集成测试
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 npm test -- tests/longbridgeLiveDecision.integration.test.ts
     ```
   - 成功标准：
     - Prompt 中 `platformRuntime.platform` 为 `Longbridge`。
     - Prompt 中 `marketData.source` 为 `longbridge-cli`。
     - Prompt 包含真实 K 线。
     - Prompt 中不包含 `Futu REAL`、`Futu OpenD`。
     - 未设置 `RUN_LONGBRIDGE_LLM_INTEGRATION=1` 时，真实 LLM 用例跳过。

5. 真实 LLM 决策测试
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 npm test -- tests/longbridgeLiveDecision.integration.test.ts
     ```
   - 成功标准：
     - 大模型返回可解析 JSON。
     - ticker 与目标一致。
     - action 属于 `HOLD | BUY | SELL_SHORT | SELL_TO_CLOSE`。
     - 非 HOLD 且 approved 时，quantity 和 limitPrice 合法。

6. 组合策略 dry-run 测试
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 RUN_LONGBRIDGE_DRY_RUN=1 npm test -- tests/longbridgeLiveTradingDryRun.test.ts
     ```
   - 成功标准：
     - `runOnceDryRun('AAPL.US')` 完成。
     - marketData 为 Longbridge 真实数据。
     - signal 写入 Longbridge 独立 persistence。
     - 组合策略开启时 candidate pool enabled 为 true。
     - pendingOrders 如生成，只存在于 Longbridge 独立队列。
     - `LONGBRIDGE_LIVE_TRADING_ENABLED` 未开启，确认接口不得提交真实订单。

7. 手工 smoke 测试
   - 命令：
     ```bash
     PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 node --import tsx scripts/longbridge-live-smoke.ts AAPL.US
     ```
   - 成功标准：
     - 输出 Longbridge auth 为 authenticated。
     - 输出 CLI version。
     - 输出资产总览、现金、购买力、持仓数量。
     - 输出行情 lastPrice、bars、ticks、asks、bids。
     - 输出 Prompt source 为 Longbridge。
     - 输出 dry-run decision。
     - 如生成 pending order，Gate check 返回 blocked。

### 3. 建议的测试 symbol

首轮只跑：

- `AAPL.US`

原因：

- 美股流动性高，quote/K 线/成交数据更稳定。
- 当前已有用例以 `AAPL.US` 为主，便于定位失败原因。

第二轮可扩展：

- `NVDA.US`
- `TSLA.US`
- `700.HK`

扩展条件：

- `AAPL.US` 全部通过。
- 港股交易时段或 Longbridge 可返回稳定的港股行情/K 线。

### 4. API 手工验证步骤

如果需要通过页面或 HTTP 验证，启动服务后依次调用：

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm run dev
```

只读接口：

```bash
curl http://localhost:3000/api/longbridge/source/status
curl http://localhost:3000/api/longbridge/workbench/dashboard
curl http://localhost:3000/api/longbridge/realtime/AAPL.US
curl http://localhost:3000/api/longbridge/live-trading/dashboard
```

dry-run 决策接口：

```bash
curl -X POST http://localhost:3000/api/longbridge/live-trading/run-once \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL.US"}'
```

待确认订单门禁接口：

```bash
curl -X POST http://localhost:3000/api/longbridge/live-trading/pending-orders/<pendingOrderId>/confirm
```

成功标准：

- `run-once` 能返回 Longbridge `marketData`、`decision`、`candidatePool`、`pendingOrders`。
- `confirm` 在未开启 `LONGBRIDGE_LIVE_TRADING_ENABLED=true` 时返回 403，并包含门禁关闭原因。

### 5. 测试结果记录

实际执行后需要记录：

- CLI 登录状态。
- 被测 symbol。
- quote 是否成功。
- K 线数量。
- depth/trades 是否为空以及 warnings。
- LLM action、approved、confidence、quantity、limitPrice。
- candidate pool 状态。
- pending order 数量。
- confirm 门禁返回。

记录位置建议：

- 直接在对话中汇总关键结果。
- 如需要长期留档，再新增 `.trae/documents/longbridge_live_trading_test_result_<date>.md`。

## Assumptions & Decisions

- 当前用户已开启组合策略，因此 dry-run 使用 `candidate_pool` 作为主要验证路径。
- 本轮不提交真实订单，不实现 Longbridge 真实下单 adapter。
- 本轮允许真实调用 Longbridge CLI 和真实 LLM。
- 测试默认 symbol 为 `AAPL.US`。
- Futu 相关代码、接口、队列、持久化不参与本轮测试。
- Longbridge 测试数据写入只使用 Longbridge 独立内存/测试 persistence，不写入 Futu 实盘表。
- `trade_strategy` YAML 只读取，不为测试修改。

## Verification Steps

按顺序执行：

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm run check
```

```bash
PATH="$PWD/.tools/node/bin:$PATH" npm test -- tests/longbridgeLiveTradingDryRun.test.ts
```

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 npm test -- tests/longbridgeMarketData.integration.test.ts
```

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 npm test -- tests/longbridgeLiveDecision.integration.test.ts
```

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 npm test -- tests/longbridgeLiveDecision.integration.test.ts
```

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 RUN_LONGBRIDGE_LLM_INTEGRATION=1 RUN_LONGBRIDGE_DRY_RUN=1 npm test -- tests/longbridgeLiveTradingDryRun.test.ts
```

```bash
PATH="$PWD/.tools/node/bin:$PATH" RUN_LONGBRIDGE_INTEGRATION=1 node --import tsx scripts/longbridge-live-smoke.ts AAPL.US
```

验收标准：

- 静态检查通过。
- 门禁测试通过。
- 行情/K 线真实集成测试通过。
- Prompt 构造测试通过。
- LLM 决策测试能返回合法 JSON。
- dry-run 不提交真实订单。
- smoke 输出显示 Longbridge 数据源、真实行情、真实 Prompt 数据来源和门禁拦截结果。
