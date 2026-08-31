# 实盘交易费用查询补充计划

## Summary

本次补充确认：Futu 实盘环境支持获取订单交易费用，接口为 `OpenSecTradeContext.order_fee_query(order_id_list=[], trd_env=TrdEnv.REAL, acc_id=0, acc_index=0)`。本地 SDK 版本 `10.07.6708` 已包含该方法；只读验证显示 REAL 环境可成功返回 `order_id`、`fee_amount`、`fee_details`。这与此前模拟盘结论不同：Futu 官方 Q&A 明确模拟盘账户不支持查询订单费用，因此模拟盘继续使用估算费用模型。

实盘实现中应新增“真实费用查询优先、估算费用兜底”的费用上下文，不再把实盘费用长期视作仅估算。

## Current State Analysis

### 当前模拟盘费用逻辑

- `api/simulation/feeContextService.ts`
  - 当前提供：
    - `estimateSingleOrderFee(quantity, price)`
    - `estimateRoundTripFee(quantity, entryPrice, exitPrice)`
    - `buildPositionFeeContext(position, marketPrice)`
    - `feeModelDescription()`
  - 费用来源固定为 `estimated`。
  - 文案明确：`Futu SIMULATE does not support order_fee_query`。

- `api/simulation/llmTradingDecisionService.ts`
  - Prompt 注入 `feeContextRules`。
  - 当前要求模型优先看 `estimatedNetUnrealizedPnL`。

- `.trae/documents/simulation_fee_context_plan.md`
  - 已记录模拟盘验证结果：`order_fee_query(..., trd_env=SIMULATE)` 返回 `Paper trading is not supported.`。

### 当前实盘设计中的费用逻辑

- `.trae/documents/live_trading_real_implementation_design_plan.md`
  - 已提出可选新增 `api/futu_bridge/futu_live_fee.py`。
  - 但原文仍偏保守地描述为“如 Futu REAL 可用，接入真实 `order_fee_query`；若不可用，估算兜底”。
  - 现在应升级为明确决策：Futu REAL 支持，实盘实现必须接入。

- `.trae/documents/live_trading_prototype.html`
  - 原型中仍展示“真实费用接口待接入，当前确认弹窗使用后端估算费用标记”。
  - 后续原型迭代应调整为“成交后可回填真实费用；提交前仍展示估算费用”。

### 本次只读验证结果

1. 本地 Futu Python SDK：
   - 版本：`10.07.6708`
   - `OpenSecTradeContext` 存在方法：`order_fee_query`
   - 方法签名：
     - `order_fee_query(self, order_id_list=[], trd_env='REAL', acc_id=0, acc_index=0)`
   - 返回表字段：
     - `order_id`
     - `fee_amount`
     - `fee_details`

2. REAL 空列表只读调用：
   - `ctx.order_fee_query(order_id_list=[], trd_env=TrdEnv.REAL)`
   - 返回 `ret = 0`
   - 返回空 DataFrame，字段完整。

3. REAL 最近历史订单只读验证：
   - `history_order_list_query(..., trd_env=TrdEnv.REAL)` 返回 7 条历史订单。
   - 用最多 3 个订单号调用 `order_fee_query(..., trd_env=TrdEnv.REAL)` 返回 `ret = 0`。
   - 返回费用样例包含：
     - `fee_amount`
     - `fee_details`
   - 注意：样例历史订单费用明细包含期权相关费用项，后续展示时必须按订单本身资产类型呈现，不应把该明细当作美股正股固定费用结构。

4. 官方文档确认：
   - Futu OpenAPI “Get Order Fee” 文档说明 `order_fee_query` 可获取指定订单费用明细。
   - 每次请求最多 400 个订单。
   - 返回 `fee_amount` 和 `fee_details`。
   - 官方 Q&A 同时说明 paper trading accounts do not support querying order fees。

## Decisions

1. 实盘费用查询必须接入 Futu REAL `order_fee_query`。
2. 提交前无法拿到真实订单费用时，确认弹窗仍展示估算费用，并标注 `estimated_pre_trade`。
3. 订单提交成功并拿到 `orderId` 后，后台或刷新接口应调用 `order_fee_query` 回填真实费用，标注 `actual_post_trade`。
4. 如果真实费用查询失败，保留估算费用，不阻断订单状态展示，但必须显示 warning。
5. 模拟盘不改变，继续使用 `feeContextService.ts` 的估算模型。
6. 实盘 LLM 决策阶段不能依赖尚未成交的真实费用，只能使用估算费用做前置净收益判断；成交后真实费用用于历史复盘、订单详情和模型反馈上下文。

## Proposed Changes

### 1. 新增实盘费用类型

文件：`shared/types.ts`

新增类型：

```ts
export type LiveFeeSource = 'estimated_pre_trade' | 'actual_post_trade' | 'unavailable'

export type LiveOrderFeeDetail = {
  item: string
  amount: number
}

export type LiveOrderFeeContext = {
  source: LiveFeeSource
  orderId?: string
  currency: string
  feeAmount: number | null
  feeDetails: LiveOrderFeeDetail[]
  estimatedAmount?: number | null
  queriedAt?: string
  warning?: string
}
```

设计要求：

- `estimated_pre_trade` 用于确认弹窗和 LLM 前置判断。
- `actual_post_trade` 用于已提交订单详情。
- `unavailable` 用于 Futu 查询失败或订单未产生 ID。

### 2. 新增 Futu REAL 费用桥接脚本

文件：`api/futu_bridge/futu_live_fee.py`

职责：

- 读取 payload：
  - `host`
  - `port`
  - `accountId`
  - `orderIds`
- 使用：
  - `OpenSecTradeContext(filter_trdmarket=TrdMarket.US, ...)`
  - `order_fee_query(order_id_list=orderIds, trd_env=TrdEnv.REAL, acc_id=int(accountId))`
- 校验：
  - `accountId` 必须为数字。
  - `orderIds` 必须为字符串数组。
  - 每次最多 400 个订单 ID。
- 输出：
  - `ok`
  - `fees: LiveOrderFeeContext[]`
  - `warnings`

费用明细标准化：

- Futu 返回的 `fee_details` 是类似 `[('Commission', 1.99), ...]` 的列表。
- Python bridge 应转为 JSON 对象数组：
  - `{ "item": "Commission", "amount": 1.99 }`
- 对无法解析的费用项保留原始字符串到 warning，不伪造数字。

### 3. 新增实盘费用服务

文件：`api/live/liveFeeService.ts`

职责：

- `estimatePreTradeFee(intent): LiveOrderFeeContext`
  - 复用或抽取 `api/simulation/feeContextService.ts` 的估算逻辑。
  - source = `estimated_pre_trade`。

- `loadActualOrderFees(orderIds, accountId): Promise<Map<string, LiveOrderFeeContext>>`
  - 调用 `futu_live_fee.py`。
  - 使用 10 秒 TTL 缓存，避免频繁触发 OpenD 限频。
  - 对每次最多 400 个订单的限制做分批。

- `mergeFeeContext(order, estimatedFee, actualFee)`
  - 有 actual 时以 actual 为准。
  - actual 不可用时保留 estimated，并附 warning。

### 4. 接入实盘待确认弹窗

文件：未来 `src/pages/LiveTradingView.tsx` 或对应组件

交互：

- 待确认订单阶段：
  - 展示 `estimated_pre_trade`。
  - 文案：`提交前费用为估算值；成交后将从 Futu REAL 回填真实费用。`

- 已提交订单阶段：
  - 如果 `actual_post_trade` 已回填，展示真实费用总额和明细。
  - 如果查询失败，展示估算费用和 warning。

### 5. 接入实盘订单详情

文件：未来 `src/pages/LiveOrderDetailView.tsx`

展示链路：

1. 策略信号。
2. 待确认订单。
3. 用户确认。
4. Futu REAL 订单状态。
5. 费用：
   - 预估费用。
   - 真实费用。
   - 差异。
   - `fee_details` 明细。

### 6. 更新实盘设计文档与原型

文件：

- `.trae/documents/live_trading_real_implementation_design_plan.md`
- `.trae/documents/live_trading_prototype.html`

需要调整：

- 将“如 Futu REAL 可用”改为“Futu REAL 已确认支持”。
- 将原型中的“真实费用接口待接入”改为：
  - “提交前估算费用”
  - “提交后 Futu REAL 回填真实费用”

注意：本计划只描述需要更新的内容；当前 Plan Mode 不修改这些既有文档和业务文件。

## Edge Cases & Failure Modes

1. 订单刚提交成功但 Futu 费用尚未可查：
   - 显示估算费用。
   - 状态为 `actual fee pending`。

2. `order_fee_query` 返回空表：
   - 保留估算费用。
   - warning：`Futu REAL 尚未返回该订单费用，稍后刷新。`

3. `order_fee_query` 返回部分订单费用：
   - 已返回订单使用真实费用。
   - 未返回订单保留估算费用。

4. `fee_details` 包含期权或其他资产费用项：
   - 原样展示明细项。
   - 不按正股费用模型重命名。

5. Futu SDK 或 OpenD 不可用：
   - 不影响订单状态查询。
   - 费用块展示 unavailable 或 estimated。

6. 模拟盘：
   - 不调用 `futu_live_fee.py`。
   - 不改变当前估算逻辑。

## Verification Steps

实施后验证：

1. 单元测试：
   - `tests/liveFeeService.test.ts`
   - 覆盖 estimated、actual、partial actual、empty response、bridge failure。

2. Python bridge 只读验证：
   - 调用 `futu_live_fee.py`，传入真实历史订单 ID。
   - 期望返回 `ok: true` 和费用明细。

3. API 验证：
   - `GET /api/live-trading/futu-orders` 返回订单时包含费用上下文。
   - 若费用未返回，展示 warning 且不影响订单表。

4. UI 验证：
   - 待确认弹窗显示 estimated fee。
   - 已提交订单详情显示 actual fee。
   - 查询失败时显示 fallback 文案。

5. 回归验证：
   - 模拟盘测试仍通过。
   - 模拟盘 prompt 仍标记费用来源为 estimated。

## Acceptance Criteria

1. 实盘订单费用支持 Futu REAL `order_fee_query` 回填。
2. 提交前确认弹窗明确费用为估算值。
3. 提交后订单详情优先展示 Futu REAL 真实费用。
4. 真实费用不可用时有明确 warning，并保留估算费用。
5. 模拟盘仍不调用真实费用接口。
6. 费用数据不会影响 `signalId` 到订单的追踪链路。
