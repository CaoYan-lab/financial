# 大模型自主模拟盘交易改造计划

## Summary

本次改造目标是将当前 Futu SIMULATE 模拟盘量化交易从“本地 Dual Thrust 策略 + 大模型确认”改为“大模型直接生成交易决策 + 后端硬风控校验 + Futu SIMULATE 自动下单”。同时删除本地量化策略实现，不再使用 `je-suis-tm/quant-trading` 思想或本地 Dual Thrust 规则。

用户已确认关键决策：

- 股票池使用用户给定列表：`MU`、`NVDA`、`GOOG`、`AAPL`、`TSM`、`TSLA`、`SPCX`、`SNDK`、`AMZN`。
- `google` 固定映射为 `GOOG`，符合项目既有约束。
- `NVdia` 映射为 `NVDA`，`tesla` 映射为 `TSLA`，`闪迪SNDK` 映射为 `SNDK`。
- `SpaceX` 使用 `SPCX` 代替；如 Futu 无法订阅或无法下单，则只记录跳过原因，不做推测替代。
- 大模型输出交易决策后，只要模型批准且通过后端硬规则，即可直接提交 Futu `SIMULATE` 模拟盘订单。
- 启动模拟交易引擎时先问一轮大模型：“需要多长时间窗口的数据”，随后按模型建议的数据窗口进行每轮股票轮询。

## Current State Analysis

### Backend Current State

- `api/simulation/simulationTradingEngine.ts`
  - 当前引擎启动时订阅 Top30。
  - 当前 `runOnce()` 对 universe 逐个调用 `loadStrategyMarketData()`。
  - 当前先执行 `evaluateDualThrustBreakout()` 生成本地策略信号。
  - 当前只有本地信号为 `BUY` 或 `SELL_TO_CLOSE` 时才构造订单。
  - 当前调用 `reviewStrategyExecution()` 让大模型确认订单。
  - 当前仍含本地费用感知仓位函数、ATR 计算和 Dual Thrust 信号流程。

- `api/simulation/strategies/dualThrustBreakout.ts`
  - 当前本地策略实现文件。
  - 需要删除，不再使用本地 Dual Thrust / `je-suis-tm/quant-trading` 思想。

- `api/simulation/llmStrategyReviewer.ts`
  - 当前定位是“大模型确认员”，不是“大模型策略决策者”。
  - 当前 prompt 让模型判断是否允许执行已有订单。
  - 当前已经能传入最近 K 线、分时点、摆盘、账户权益、费用模型、风险模型、Top30 白名单和 SIMULATE 上下文。
  - 需要改造成“大模型策略决策服务”，直接输出 `HOLD` / `BUY` / `SELL_TO_CLOSE`、数量、限价、理由、风险、置信度。

- `api/simulation/realtimeDataAdapter.ts`
  - 当前从 `realtimeStore.snapshot(ticker)` 获取实时回调缓存。
  - 当前返回 `bars`、`tickerPoints`、`asks`、`bids`、`bestAsk`、`bestBid`。
  - 可复用，但需要支持按大模型推荐窗口裁剪数据。

- `api/realtime/realtimeSubscriptionService.ts`
  - 当前内部 `start(tickers: string[])` 支持任意 ticker 数组。
  - 当前 API 只暴露 `/api/realtime/subscribe-top30`，模拟引擎也只自动订阅 Top30。
  - 需要让模拟引擎直接调用 `start(customUniverse)`，或新增 `/api/realtime/subscribe` 接口支持自定义股票池。

- `api/routes/simulationRoutes.ts`
  - 当前 `llm-test` 调用 `reviewStrategyExecution()`。
  - 需要新增或调整测试接口为 LLM 策略决策测试。

- `api/futu_bridge/futu_sim_order.py`
  - 当前严格使用 `TrdEnv.SIMULATE`。
  - 当前只允许 `BUY` 和 `SELL_TO_CLOSE`。
  - 当前拒绝期权。
  - 可保留作为执行层。
  - 默认 strategy 字段仍是 `DUAL_THRUST_BREAKOUT`，需要改为大模型策略名称。

- `shared/types.ts`
  - 当前 `QuantStrategyName = 'DUAL_THRUST_BREAKOUT'`。
  - 当前 `QuantSignal` 有 `upperThreshold/lowerThreshold` 字段，强绑定突破策略。
  - 需要改为 LLM 自主交易信号结构，例如 `LLM_AUTONOMOUS_STOCK_TRADER`，并增加 `actionReason`、`riskAssessment`、`dataWindowUsed`、`modelDecision` 等字段。

### Frontend Current State

- `src/pages/SimulationTradingView.tsx`
  - 当前页面显示策略为 `DUAL_THRUST_BREAKOUT` / “突破策略适配层”。
  - 当前表格列包含 `上轨/下轨`，强绑定本地突破策略。
  - 需要改为大模型决策视图：动作、数量、限价、置信度、模型理由、风险提示、数据窗口、模型状态。

- `src/hooks/useSimulationTrading.ts`
  - 当前只调用 dashboard/start/stop/run-once。
  - 可保留；如新增股票池配置接口或 meta window 接口，需要扩展。

### Tests Current State

- `tests/simulationStrategy.test.ts`
  - 当前覆盖本地 Dual Thrust 策略。
  - 需要删除或替换为 LLM 决策解析/风控校验测试。

- `tests/llmStrategyReviewer.test.ts`
  - 当前测试大模型确认 payload。
  - 需要改为测试：
    - 模型数据窗口建议解析。
    - 模型交易决策 JSON 解析。
    - 非 JSON / 缺字段 / 越权动作默认阻断。
    - prompt 中包含 K 线、分时、摆盘、账户、费用、风险模型、股票池。

## Proposed Changes

### 1. 删除本地策略实现

文件：

- 删除 `api/simulation/strategies/dualThrustBreakout.ts`
- 删除或重写 `tests/simulationStrategy.test.ts`

做法：

- 移除 `simulationTradingEngine.ts` 对 `evaluateDualThrustBreakout`、`formatMoney`、`positionQuantity` 的依赖。
- 不再在后端计算 Dual Thrust 上下轨。
- 不再在后端根据 ATR 生成买卖信号。
- 后端仅保留硬风控、格式校验、费用阈值、SIMULATE 执行保护。

原因：

- 用户明确要求“去掉本地量化交易策略，不再使用 `je-suis-tm/quant-trading` 思想，把这部分代码全干掉”。

### 2. 新增固定模拟盘交易股票池

文件：

- 新增 `api/simulation/simulationUniverse.ts`
- 更新 `api/simulation/simulationTradingEngine.ts`
- 可选更新 `src/pages/SimulationTradingView.tsx`

实现：

```ts
export const LLM_SIMULATION_UNIVERSE = [
  { ticker: 'MU', label: 'Micron' },
  { ticker: 'NVDA', label: 'NVIDIA' },
  { ticker: 'GOOG', label: 'Alphabet / Google-C' },
  { ticker: 'AAPL', label: 'Apple' },
  { ticker: 'TSM', label: 'TSMC ADR' },
  { ticker: 'TSLA', label: 'Tesla' },
  { ticker: 'SPCX', label: 'SPCX substitute for SpaceX' },
  { ticker: 'SNDK', label: 'SanDisk' },
  { ticker: 'AMZN', label: 'Amazon' },
] as const
```

规则：

- 交易 universe 固定使用上述列表。
- 不再从 Top30 自动选交易标的。
- 若某个 ticker 无法订阅 Futu 回调或无法下单，记录跳过原因。
- `SPCX` 按用户确认作为 SpaceX 代替标的，但必须经过 Futu 可订阅/可交易验证；不可用则跳过。

### 3. 实时订阅改为自定义 universe

文件：

- `api/simulation/simulationTradingEngine.ts`
- 可选：`api/routes/realtimeRoutes.ts`

实现：

- 引擎启动时不再 `subscribeTop30()`。
- 改为：

```ts
realtimeSubscriptionService.start(LLM_SIMULATION_UNIVERSE.map((item) => item.ticker))
```

- 预热等待逻辑改为等待上述 9 个 ticker 的实时回调缓存。
- 预热不要求所有标的都成功；若 `SPCX` 或 `SNDK` 无回调，记录跳过，但不阻塞其他标的。

### 4. 启动时先询问大模型需要的数据窗口

文件：

- 新增 `api/simulation/llmDataWindowAdvisor.ts`
- 更新 `api/simulation/simulationTradingEngine.ts`
- 更新 `shared/types.ts`

实现：

- 引擎 `start()` 时，在订阅并预热后调用一次 Ark 模型：
  - 告知交易任务：Futu SIMULATE 美股正股，股票池为用户指定 9 个 ticker。
  - 告知可用数据类型：
    - 1 分钟 K 线，当前缓存最多约 `240` 根。
    - 分时/逐笔点，当前缓存最多约 `720` 点。
    - 摆盘，当前有 `asks/bids` 五档。
    - 实时报价。
    - 模拟账户资产、购买力、持仓。
  - 要求模型返回 JSON：

```json
{
  "kline1mBars": 120,
  "tickerPoints": 240,
  "orderBookDepth": 5,
  "pollIntervalSeconds": 60,
  "reason": "..."
}
```

- 后端对模型建议做硬边界校验：
  - `kline1mBars`: `30..240`
  - `tickerPoints`: `60..720`
  - `orderBookDepth`: `1..10`
  - `pollIntervalSeconds`: `30..300`
- 如果模型调用失败或返回不可解析，则使用默认值：
  - `kline1mBars = 120`
  - `tickerPoints = 240`
  - `orderBookDepth = 5`
  - `pollIntervalSeconds = 60`

### 5. 大模型直接输出交易决策

文件：

- 新增或重命名 `api/simulation/llmStrategyReviewer.ts` 为 `api/simulation/llmTradingDecisionService.ts`
- 更新 `api/simulation/simulationTradingEngine.ts`
- 更新 `shared/types.ts`

实现：

- 每轮对交易股票池逐个 ticker 轮询。
- 对每个 ticker 取大模型建议窗口的数据：
  - 最近 N 根 1 分钟 K 线。
  - 最近 M 个分时点。
  - N 档摆盘。
  - 实时报价。
  - 当前模拟账户权益/现金/购买力。
  - 当前该标的持仓。
  - 费用模型与硬风控。
- 直接问大模型是否交易。

大模型必须返回 JSON：

```json
{
  "action": "HOLD | BUY | SELL_TO_CLOSE",
  "approved": true,
  "ticker": "NVDA",
  "quantity": 3,
  "limitPrice": 188.25,
  "confidence": "low | medium | high",
  "reason": "中文原因",
  "riskAssessment": "中文风险说明",
  "dataWindowUsed": {
    "kline1mBars": 120,
    "tickerPoints": 240,
    "orderBookDepth": 5
  }
}
```

后端处理：

- `HOLD`：记录信号，不下单。
- `BUY`：构造 `SimulatedOrderIntent`，进入硬风控。
- `SELL_TO_CLOSE`：仅允许已有正股持仓时平仓，不允许卖空。
- 模型返回非 JSON、缺字段、数量/价格不可解析、ticker 不匹配、action 非法，全部阻断。

### 6. 后端硬风控保留

文件：

- `api/simulation/simulationTradingEngine.ts`
- `api/futu_bridge/futu_sim_order.py`
- `shared/types.ts`

硬规则：

- 仅 `TrdEnv.SIMULATE`。
- 仅用户指定股票池。
- 仅正股，不做期权。
- 仅 `BUY` / `SELL_TO_CLOSE` / `HOLD`。
- 不允许卖空。
- `SELL_TO_CLOSE` 数量不得超过当前持仓数量。
- `BUY` 名义金额不得超过账户权益上限。
- 模型给出的数量必须通过最低名义金额/费用占比校验。
- 订单必须是限价单。
- 同一标的同方向仍保留冷却窗口，避免模型连续重复下单。
- 模型批准后才可提交 Futu SIMULATE 订单。

说明：

- “完全交给大模型”指交易策略判断、买卖方向、数量、价格建议由模型输出。
- 后端硬风控不是本地策略，而是执行安全边界，必须保留。

### 7. 修改类型定义

文件：

- `shared/types.ts`

变更：

- 将：

```ts
export type QuantStrategyName = 'DUAL_THRUST_BREAKOUT'
```

改为：

```ts
export type QuantStrategyName = 'LLM_AUTONOMOUS_STOCK_TRADER'
```

- 重构 `QuantSignal`：
  - 删除或废弃 `upperThreshold/lowerThreshold`。
  - 新增：
    - `action`
    - `quantity`
    - `limitPrice`
    - `modelReason`
    - `riskAssessment`
    - `dataWindowUsed`
    - `rawModelOutput?`

- 增加：
  - `LlmDataWindowRecommendation`
  - `LlmTradingDecision`
  - `SimulationUniverseItem`

### 8. 修改 UI 展示

文件：

- `src/pages/SimulationTradingView.tsx`

变更：

- 页面标题/说明从“突破策略”改为“大模型自主交易策略”。
- 运行节奏改为“评估间隔”，避免误解为只运行 60 秒。
- 增加股票池展示：
  - `MU`、`NVDA`、`GOOG`、`AAPL`、`TSM`、`TSLA`、`SPCX`、`SNDK`、`AMZN`
- 增加数据窗口展示：
  - 模型建议的 K 线根数、分时点数量、摆盘深度、轮询间隔。
- 最近策略信号表改列：
  - 标的
  - 动作
  - 数量
  - 限价
  - 置信度
  - 模型理由
  - 风险提示
  - 数据窗口
- 去掉 `上轨/下轨` 列。

### 9. 更新测试

文件：

- 删除或重写 `tests/simulationStrategy.test.ts`
- 更新 `tests/llmStrategyReviewer.test.ts`
- 可新增 `tests/llmTradingDecisionService.test.ts`

测试点：

- 模型窗口建议解析成功。
- 模型窗口建议越界时被 clamp 到安全范围。
- 模型窗口建议不可解析时使用默认值。
- 模型交易决策 JSON 解析成功。
- 非法 action 阻断。
- ticker 不在 universe 阻断。
- `SELL_TO_CLOSE` 超持仓阻断。
- `BUY` 超过风险/费用硬规则阻断。
- prompt 包含：
  - 用户股票池。
  - K 线。
  - 分时。
  - 摆盘。
  - 模拟账户。
  - 持仓。
  - 费用模型。

## Assumptions & Decisions

- 使用用户确认的股票池，不再使用 Top30 作为交易 universe。
- `SPCX` 按用户要求作为 SpaceX 替代标的，但不把它声称为 SpaceX 正股；如果 Futu 数据或交易不可用，跳过。
- 大模型使用现有 Ark endpoint：`ARK_MODEL=ep-20260616231829-mnq2t`。
- 大模型可直接批准并触发 Futu SIMULATE 下单。
- 所有下单仍仅限模拟盘。
- 后端硬风控保留，不属于本地量化策略。
- 如果模型建议的时间窗口过大或不合法，后端使用安全边界裁剪。
- 如果模型窗口建议失败，使用默认数据窗口。

## Verification Steps

1. 静态检查：

```bash
npm run check
```

2. 单元测试：

```bash
npm test
```

3. 构建：

```bash
npm run build
```

4. API 验证：

```bash
curl -s http://localhost:3001/api/simulation/dashboard
curl -s -X POST http://localhost:3001/api/simulation/llm-test
```

5. 启动模拟盘后验证：

- 实时订阅列表为用户股票池，而不是 Top30。
- 首次启动会记录大模型数据窗口建议。
- 最近策略信号由大模型直接生成，不再出现 Dual Thrust 上轨/下轨。
- 模型返回 `HOLD` 时不下单。
- 模型返回 `BUY/SELL_TO_CLOSE` 且通过硬风控时提交 Futu SIMULATE 订单。
- `SPCX` / `SNDK` 如不可订阅或不可交易，应显示明确跳过原因。
- 页面显示“大模型自主交易策略”和数据窗口建议。

